import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const saveArtifacts = process.argv.includes("--artifacts");
const children = [];
let browserClient;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHttp(url, label) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${label} did not become ready: ${lastError?.message ?? "timeout"}`);
}

function chromeExecutable() {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new Error("Google Chrome or Chromium is required for npm run verify:ui.");
  return executable;
}

function stopProcess(child) {
  if (!child?.pid) return;
  child.kill("SIGTERM");
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = undefined;
    this.socket = new WebSocket(webSocketUrl);
  }

  async connect() {
    await new Promise((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to Chrome DevTools.")), 10000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}, useSession = true) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome did not answer ${method}.`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      const message = { id, method, params };
      if (useSession && this.sessionId) message.sessionId = this.sessionId;
      this.socket.send(JSON.stringify(message));
    });
  }

  async evaluate(expression) {
    const response = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
    }
    return response.result.value;
  }
}

async function waitForDevTools(child, profile) {
  const endpointFile = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Chrome exited before DevTools started (code ${child.exitCode}).`);
    if (existsSync(endpointFile)) {
      const [port, endpointPath] = readFileSync(endpointFile, "utf8").trim().split(/\r?\n/);
      if (port && endpointPath) return `ws://127.0.0.1:${port}${endpointPath}`;
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools did not start within 15 seconds.");
}

async function waitForPage(client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await client.evaluate("document.readyState === 'complete' && Boolean(document.querySelector('.play-button'))");
    if (ready) return;
    await delay(100);
  }
  throw new Error("Songless did not finish rendering.");
}

async function clickStage(client, label) {
  const clicked = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('.stage-pill')]
      .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, `Could not find the ${label} stage button.`);
  await delay(40);
}

async function stageState(client) {
  return client.evaluate(`(() => {
    const track = document.querySelector('.stage-track').getBoundingClientRect();
    const unlocked = document.querySelector('.stage-unlocked-progress').getBoundingClientRect();
    const playback = document.querySelector('.stage-playback-progress').getBoundingClientRect();
    const half = document.querySelector('[data-stage="0.5"]').getBoundingClientRect();
    const current = document.querySelector('.stage-pill.current');
    return {
      current: current?.textContent.trim() ?? null,
      passed: document.querySelectorAll('.stage-segment.passed').length,
      trackLeft: track.left,
      halfLeft: half.left,
      unlockedWidth: unlocked.width,
      playbackWidth: playback.width,
      message: document.querySelector('.game-message')?.textContent.trim() ?? null,
    };
  })()`);
}

async function run() {
  const appPort = await freePort();
  const profile = mkdtempSync(path.join(os.tmpdir(), "songless-ui-audit-"));
  const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
  assert(existsSync(viteBin), "Run npm install before npm run verify:ui.");

  try {
    const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(appPort)], {
      cwd: root,
      stdio: "ignore",
    });
    children.push(vite);
    await waitForHttp(`http://127.0.0.1:${appPort}`, "Vite");

    const chromeArguments = [
      "--headless=new",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-networking",
      "--disable-breakpad",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-default-browser-check",
      "--no-first-run",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1918,1079",
      "about:blank",
    ];
    // Chrome's process sandbox cannot initialize inside Codex's restricted
    // workspace sandbox. The audit still uses a disposable profile and only
    // visits the local Vite server. Normal developer runs retain Chrome's sandbox.
    if (process.env.CODEX_PERMISSION_PROFILE) chromeArguments.unshift("--no-sandbox");
    const chrome = spawn(chromeExecutable(), chromeArguments, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    chrome.stderr.resume();
    children.push(chrome);
    const endpoint = await waitForDevTools(chrome, profile);
    const client = new CdpClient(endpoint);
    browserClient = client;
    await client.connect();
    const targetResponse = await client.call("Target.getTargets", {}, false);
    const page = targetResponse.targetInfos.find((target) => target.type === "page");
    assert(page?.targetId, "Chrome did not expose a page target.");
    const attached = await client.call("Target.attachToTarget", { targetId: page.targetId, flatten: true }, false);
    client.sessionId = attached.sessionId;
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 1918,
      height: 1079,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.call("Page.navigate", { url: `http://127.0.0.1:${appPort}` });
    await waitForPage(client);
    await client.evaluate("localStorage.clear(); location.reload();");
    await waitForPage(client);
    await delay(150);

    const mediumSelected = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('.difficulty-tabs button')]
        .find((node) => node.textContent.trim() === 'Medium');
      button?.click();
      return Boolean(button);
    })()`);
    assert(mediumSelected, "Could not select Medium from the central difficulty tabs.");
    await delay(100);
    const linkedDifficulty = await client.evaluate(`({
      difficulty: document.querySelector('.app-shell').dataset.difficulty,
      central: document.querySelector('.difficulty-tabs .medium')?.classList.contains('active'),
      side: document.querySelector('.difficulty-list .medium')?.classList.contains('active'),
    })`);
    assert(linkedDifficulty.difficulty === "medium" && linkedDifficulty.central && linkedDifficulty.side,
      "Central difficulty selection did not update the full interface.");
    const defaultStages = await client.evaluate(`[...document.querySelectorAll('.stage-pill.enabled')]
      .map((node) => node.textContent.trim())`);
    assert(JSON.stringify(defaultStages) === JSON.stringify(["0.1s", "0.5s", "2s", "8s", "15s"]),
      `Default stages are incorrect (${JSON.stringify(defaultStages)}).`);

    const icon = await client.evaluate(`(() => {
      const button = document.querySelector('.play-button').getBoundingClientRect();
      const path = document.querySelector('.play-icon path').getBoundingClientRect();
      return {
        xOffset: (path.left + path.width / 2) - (button.left + button.width / 2),
        yOffset: (path.top + path.height / 2) - (button.top + button.height / 2),
      };
    })()`);
    assert(icon.xOffset >= 1.5 && icon.xOffset <= 5,
      `Play triangle visual-weight offset is wrong on X (${icon.xOffset.toFixed(2)}px).`);
    assert(Math.abs(icon.yOffset) <= 0.75,
      `Play triangle is not centered on Y (${icon.yOffset.toFixed(2)}px).`);
    console.log(`PASS play triangle optical center (x +${icon.xOffset.toFixed(2)}px, y ${icon.yOffset.toFixed(2)}px)`);

    await clickStage(client, "0.1s");
    const removalStart = await stageState(client);
    assert(removalStart.current === "0.5s", `Removing 0.1s selected ${removalStart.current}, expected 0.5s.`);
    assert(removalStart.halfLeft > removalStart.trackLeft + 2,
      "The 0.5s segment jumped to the start before its reflow animation began.");
    await delay(850);
    const removalEnd = await stageState(client);
    assert(Math.abs(removalEnd.halfLeft - removalEnd.trackLeft) <= 2,
      "The 0.5s segment did not finish reflowing to the start.");
    assert(removalEnd.unlockedWidth > removalStart.unlockedWidth,
      "The translucent unlocked range did not expand with the new current stage.");

    await clickStage(client, "0.1s");
    await delay(850);
    let state = await stageState(client);
    assert(state.current === "0.1s", `Restoring 0.1s left ${state.current} current.`);
    assert(state.passed === 0, `Restoring an earlier stage incorrectly painted ${state.passed} segment(s) as passed.`);
    assert(state.message === null, `Routine stage status text is still visible: ${state.message}`);

    await clickStage(client, "0.01s");
    await delay(850);
    state = await stageState(client);
    assert(state.current === "0.01s", `Adding 0.01s left ${state.current} current.`);
    assert(state.passed === 0, "Adding 0.01s incorrectly created a passed-color segment.");
    await clickStage(client, "0.01s");
    await delay(850);
    await clickStage(client, "0.01s");
    await delay(850);
    state = await stageState(client);
    assert(state.current === "0.01s" && state.passed === 0,
      "The remove/re-add 0.01s sequence corrupted current or passed stage colors.");
    console.log("PASS stage remove/re-add state and translucent unlocked-range reflow");

    const volume = await client.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Volume"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '0.4');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert(volume, "Could not set volume during the browser audit.");
    await delay(100);
    const volumeState = await client.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Volume"]');
      return {
        value: Number(input.value),
        percent: getComputedStyle(input).getPropertyValue('--volume-percent').trim(),
      };
    })()`);
    assert(volumeState.value === 0.4 && volumeState.percent === "40%",
      `Volume fill state is incorrect (${JSON.stringify(volumeState)}).`);
    console.log("PASS volume fill boundary follows the thumb (40% filled / 60% unfilled)");

    await clickStage(client, "0.01s");
    await client.evaluate("document.querySelector('.skip-button').click()");
    await delay(60);
    await client.evaluate("document.querySelector('.skip-button').click()");
    await delay(100);
    state = await stageState(client);
    assert(state.current === "2s" && state.message === null,
      `Playback audit expected the silent cumulative 2s stage (${JSON.stringify(state)}).`);

    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(2200);
    const completed = await client.evaluate(`(() => {
      const fill = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      const unlocked = document.querySelector('.stage-unlocked-progress').getBoundingClientRect();
      const segment = document.querySelector('[data-stage="2"]').getBoundingClientRect();
      const track = document.querySelector('.stage-track').getBoundingClientRect();
      return {
        playIcon: Boolean(document.querySelector('.play-icon')),
        isPlaying: document.querySelector('.play-button').classList.contains('playing'),
        progress: Number(document.querySelector('.stage-playback-progress').dataset.progress),
        fillWidth: fill.width,
        unlockedWidth: unlocked.width,
        endpointWidth: segment.right - track.left,
        dividers: [...document.querySelectorAll('.stage-segment.enabled:not(.last-enabled)')]
          .filter((node) => parseFloat(getComputedStyle(node).borderRightWidth) >= 1).length,
      };
    })()`);
    assert(completed.playIcon && !completed.isPlaying && completed.progress === 1,
      `Completed playback did not restore the play state (${JSON.stringify(completed)}).`);
    assert(Math.abs(completed.fillWidth - completed.endpointWidth) <= 3 &&
      Math.abs(completed.unlockedWidth - completed.endpointWidth) <= 3,
      `Completed playback did not make the unlocked range opaque (${JSON.stringify(completed)}).`);
    assert(completed.dividers === 4, `Section dividers disappeared over the fills (${completed.dividers}/4).`);

    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(250);
    const replayed = await client.evaluate(`({
      isPlaying: document.querySelector('.play-button').classList.contains('playing'),
      elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
      progress: Number(document.querySelector('.stage-playback-progress').dataset.progress),
    })`);
    assert(replayed.isPlaying && replayed.elapsed > 0.1 && replayed.elapsed < 0.6 && replayed.progress < 0.3,
      `Replay did not restart its opaque sweep from zero (${JSON.stringify(replayed)}).`);
    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(100);

    await client.evaluate("document.querySelector('.skip-button').click()");
    await delay(850);
    const skipped = await client.evaluate(`(() => {
      const track = document.querySelector('.stage-track').getBoundingClientRect();
      const played = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      const unlocked = document.querySelector('.stage-unlocked-progress').getBoundingClientRect();
      const completedBoundary = document.querySelector('[data-stage="2"]').getBoundingClientRect().right - track.left;
      const unlockedBoundary = document.querySelector('[data-stage="8"]').getBoundingClientRect().right - track.left;
      return {
        current: document.querySelector('.stage-pill.current')?.textContent.trim(),
        passed: document.querySelectorAll('.stage-segment.passed').length,
        message: document.querySelector('.game-message')?.textContent.trim() ?? null,
        playedWidth: played.width,
        unlockedWidth: unlocked.width,
        completedBoundary,
        unlockedBoundary,
        dividers: [...document.querySelectorAll('.stage-segment.enabled:not(.last-enabled)')]
          .filter((node) => parseFloat(getComputedStyle(node).borderRightWidth) >= 1).length,
      };
    })()`);
    assert(skipped.current === "8s" && skipped.passed === 3 && skipped.message === null,
      `Skip did not silently unlock the 8s section (${JSON.stringify(skipped)}).`);
    assert(Math.abs(skipped.playedWidth - skipped.completedBoundary) <= 3,
      `Skip did not retain the completed opaque range (${JSON.stringify(skipped)}).`);
    assert(Math.abs(skipped.unlockedWidth - skipped.unlockedBoundary) <= 3 &&
      skipped.unlockedWidth > skipped.playedWidth,
      `Skip did not add a translucent next section (${JSON.stringify(skipped)}).`);
    assert(skipped.dividers === 4, `Skip obscured section dividers (${skipped.dividers}/4).`);

    if (saveArtifacts) {
      const artifactDirectory = path.join(root, ".ui-audit");
      mkdirSync(artifactDirectory, { recursive: true });
      const capture = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeFileSync(path.join(artifactDirectory, "skipped-state.png"), Buffer.from(capture.data, "base64"));
      console.log(`Saved ${path.relative(root, path.join(artifactDirectory, "skipped-state.png"))}`);
    }

    const started = await client.evaluate(`(() => {
      const button = document.querySelector('.play-button');
      button.click();
      return Boolean(button);
    })()`);
    assert(started, "Could not start the clip during the playback audit.");
    await delay(350);
    const playing = await client.evaluate(`(() => {
      const button = document.querySelector('.play-button').getBoundingClientRect();
      const pauseParts = [...document.querySelectorAll('.pause-icon rect')]
        .map((node) => node.getBoundingClientRect());
      const left = Math.min(...pauseParts.map((part) => part.left));
      const right = Math.max(...pauseParts.map((part) => part.right));
      const top = Math.min(...pauseParts.map((part) => part.top));
      const bottom = Math.max(...pauseParts.map((part) => part.bottom));
      const fill = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      const first = document.querySelector('[data-stage="0.1"]').getBoundingClientRect();
      const second = document.querySelector('[data-stage="0.5"]').getBoundingClientRect();
      const track = document.querySelector('.stage-track').getBoundingClientRect();
      return {
        isPlaying: document.querySelector('.play-button').classList.contains('playing'),
        label: document.querySelector('.play-button').getAttribute('aria-label'),
        pauseParts: pauseParts.length,
        pauseX: ((left + right) / 2) - (button.left + button.width / 2),
        pauseY: ((top + bottom) / 2) - (button.top + button.height / 2),
        progress: Number(document.querySelector('.stage-playback-progress').dataset.progress),
        elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
        fillWidth: fill.width,
        firstWidth: first.width,
        secondBoundary: second.right - track.left,
      };
    })()`);
    assert(playing.isPlaying && playing.label === "Stop clip playback" && playing.pauseParts === 2,
      `Play button did not switch to the active pause state (${JSON.stringify(playing)}).`);
    assert(Math.abs(playing.pauseX) <= 0.75 && Math.abs(playing.pauseY) <= 0.75,
      `Pause icon is not centered (${playing.pauseX.toFixed(2)}px, ${playing.pauseY.toFixed(2)}px).`);
    assert(playing.progress > 0.02 && playing.progress < 0.12,
      `Playback progress did not advance at the expected rate (${playing.progress}).`);
    assert(playing.elapsed > 0.2 && playing.elapsed < 0.7,
      `The cumulative 8s clip did not begin near song time zero (${playing.elapsed}s).`);
    assert(playing.fillWidth > playing.firstWidth && playing.fillWidth < playing.secondBoundary,
      `Timeline fill did not replay from the first stage boundary (${JSON.stringify(playing)}).`);
    console.log("PASS opaque replay sweep starts at zero over the translucent 0-8s range");

    if (saveArtifacts) {
      const artifactDirectory = path.join(root, ".ui-audit");
      mkdirSync(artifactDirectory, { recursive: true });
      const capture = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeFileSync(path.join(artifactDirectory, "playing-state.png"), Buffer.from(capture.data, "base64"));
      console.log(`Saved ${path.relative(root, path.join(artifactDirectory, "playing-state.png"))}`);
    }

    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(100);
    const stopped = await client.evaluate(`(() => {
      const track = document.querySelector('.stage-track').getBoundingClientRect();
      const fill = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      const completedBoundary = document.querySelector('[data-stage="2"]').getBoundingClientRect().right - track.left;
      return {
        playIcon: Boolean(document.querySelector('.play-icon')),
        isPlaying: document.querySelector('.play-button').classList.contains('playing'),
        fillWidth: fill.width,
        completedBoundary,
      };
    })()`);
    assert(stopped.playIcon && !stopped.isPlaying &&
      Math.abs(stopped.fillWidth - stopped.completedBoundary) <= 3,
      `Stopping replay did not restore the last completed opaque range (${JSON.stringify(stopped)}).`);
    console.log("PASS completion, skip, replay, and stop preserve the three timeline layers");

    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(200);
    const narrow = await client.evaluate(`(() => {
      const button = document.querySelector('.play-button').getBoundingClientRect();
      const iconPath = document.querySelector('.play-icon path').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        xOffset: (iconPath.left + iconPath.width / 2) - (button.left + button.width / 2),
        yOffset: (iconPath.top + iconPath.height / 2) - (button.top + button.height / 2),
      };
    })()`);
    assert(narrow.overflow <= 1, `Narrow layout overflows horizontally by ${narrow.overflow}px.`);
    assert(narrow.xOffset >= 1 && narrow.xOffset <= 4 && Math.abs(narrow.yOffset) <= 0.75,
      `Play triangle lost optical alignment at 720px (${JSON.stringify(narrow)}).`);
    console.log("PASS 720px responsive layout and play-icon alignment");

    console.log("UI audit passed.");
  } finally {
    browserClient?.socket.close();
    for (const child of children.reverse()) stopProcess(child);
    await delay(500);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      // A Chrome subprocess can briefly retain a cache file on Windows. The
      // disposable profile remains under the operating-system temp directory.
    }
  }
}

run().catch((error) => {
  console.error(`UI audit failed: ${error.message}`);
  process.exitCode = 1;
});
