import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const saveArtifacts = process.argv.includes("--artifacts");
const verifyHostedPlayback = process.argv.includes("--hosted-smoke");
const requestedHostedSongId = process.argv.find((value) => value.startsWith("--hosted-id="))?.split("=")[1];
const hostedSongId = requestedHostedSongId ?? "beach-house-space-song";
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

async function setStageEnabled(client, label, enabled) {
  const current = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('.stage-pill')]
      .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    return button?.getAttribute('aria-pressed') === 'true';
  })()`);
  if (current !== enabled) await clickStage(client, label);
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
  const catalogFile = path.join(root, "public", "catalog.json");
  const demoCatalogFile = path.join(root, "public", "catalog-demo-backup.json");
  const originalCatalog = readFileSync(catalogFile);
  const reviewCatalogFile = path.join(root, "public", "review-catalog.json");
  const originalReviewCatalog = existsSync(reviewCatalogFile) ? readFileSync(reviewCatalogFile) : null;
  const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
  assert(existsSync(viteBin), "Run npm install before npm run verify:ui.");
  assert(existsSync(demoCatalogFile), "The deterministic UI demo catalogue is missing.");
  writeFileSync(catalogFile, readFileSync(demoCatalogFile));

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
    assert(volumeState.value === 0.4 && volumeState.percent === "8%",
      `Volume fill state is incorrect (${JSON.stringify(volumeState)}).`);
    console.log("PASS volume fill boundary follows the thumb (40% output on the 0-500% range)");

    const autoRerollFound = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('.settings-panel .setting-value')]
        .find((node) => node.textContent.trim().startsWith('Auto reroll'));
      button?.click();
      return Boolean(button);
    })()`);
    await delay(100);
    const autoRerollSetting = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('.settings-panel .setting-value')]
        .find((node) => node.textContent.trim().startsWith('Auto reroll'));
      return { pressed: button?.getAttribute('aria-pressed'), stored: localStorage.getItem('songless-auto-reroll') };
    })()`);
    assert(autoRerollFound && autoRerollSetting.pressed === "true"
      && autoRerollSetting.stored === "true",
    `Auto-reroll setting did not enable and persist (${JSON.stringify(autoRerollSetting)}).`);

    await clickStage(client, "0.01s");
    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(1500);
    let playbackState = await client.evaluate(`({
      current: document.querySelector('.stage-pill.current')?.textContent.trim(),
      isPlaying: document.querySelector('.play-button').classList.contains('playing'),
      elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
    })`);
    assert(playbackState.current === "0.1s" && !playbackState.isPlaying && playbackState.elapsed === 0.1,
      `The initial 0-0.1s clue did not complete cleanly (${JSON.stringify(playbackState)}).`);
    const lockedStages = await client.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.stage-pill')];
      const before = buttons.map((button) => button.getAttribute('aria-pressed'));
      buttons[0].click();
      const after = buttons.map((button) => button.getAttribute('aria-pressed'));
      return {
        disabled: buttons.filter((button) => button.disabled).length,
        before,
        after,
        stageCount: document.querySelector('.stage-track').dataset.stageCount,
      };
    })()`);
    assert(lockedStages.disabled === 6 &&
      JSON.stringify(lockedStages.before) === JSON.stringify(lockedStages.after) &&
      lockedStages.stageCount === "5",
      `Stage settings changed after playback locked them (${JSON.stringify(lockedStages)}).`);
    console.log("PASS first Play locks every stage setting against native and scripted clicks");

    await client.evaluate("document.querySelector('.skip-button').click()");
    await delay(100);
    playbackState = await client.evaluate(`({
      current: document.querySelector('.stage-pill.current')?.textContent.trim(),
      isPlaying: document.querySelector('.play-button').classList.contains('playing'),
      elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
    })`);
    assert(playbackState.current === "0.5s" && !playbackState.isPlaying && playbackState.elapsed === 0.1,
      `Skip started audio before Play was pressed (${JSON.stringify(playbackState)}).`);
    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(150);
    let incremental = await client.evaluate(`(() => {
      const track = document.querySelector('.stage-track').getBoundingClientRect();
      const fill = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      return {
        current: document.querySelector('.stage-pill.current')?.textContent.trim(),
        isPlaying: document.querySelector('.play-button').classList.contains('playing'),
        elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
        fillWidth: fill.width,
        priorBoundary: document.querySelector('[data-stage="0.1"]').getBoundingClientRect().right - track.left,
        currentBoundary: document.querySelector('[data-stage="0.5"]').getBoundingClientRect().right - track.left,
      };
    })()`);
    assert(incremental.current === "0.5s" && incremental.isPlaying &&
      incremental.elapsed > 0.18 && incremental.elapsed < 0.4,
      `Play after Skip did not continue from 0.1s (${JSON.stringify(incremental)}).`);
    assert(incremental.fillWidth > incremental.priorBoundary &&
      incremental.fillWidth < incremental.currentBoundary,
      `The 0.1-0.5s continuation is outside its visual interval (${JSON.stringify(incremental)}).`);
    await delay(350);

    await client.evaluate("document.querySelector('.skip-button').click()");
    await delay(100);
    playbackState = await client.evaluate(`({
      current: document.querySelector('.stage-pill.current')?.textContent.trim(),
      isPlaying: document.querySelector('.play-button').classList.contains('playing'),
      elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
    })`);
    assert(playbackState.current === "2s" && !playbackState.isPlaying && playbackState.elapsed === 0.5,
      `Skip to 2s was not silent (${JSON.stringify(playbackState)}).`);
    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(250);
    incremental = await client.evaluate(`(() => {
      const track = document.querySelector('.stage-track').getBoundingClientRect();
      const fill = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      return {
        current: document.querySelector('.stage-pill.current')?.textContent.trim(),
        isPlaying: document.querySelector('.play-button').classList.contains('playing'),
        elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
        fillWidth: fill.width,
        priorBoundary: document.querySelector('[data-stage="0.5"]').getBoundingClientRect().right - track.left,
        currentBoundary: document.querySelector('[data-stage="2"]').getBoundingClientRect().right - track.left,
      };
    })()`);
    assert(incremental.current === "2s" && incremental.isPlaying &&
      incremental.elapsed > 0.65 && incremental.elapsed < 1.1,
      `Play after Skip did not continue from 0.5s (${JSON.stringify(incremental)}).`);
    assert(incremental.fillWidth > incremental.priorBoundary &&
      incremental.fillWidth < incremental.currentBoundary,
      `The 0.5-2s continuation is outside its visual interval (${JSON.stringify(incremental)}).`);
    await delay(1400);

    playbackState = await client.evaluate(`({
      current: document.querySelector('.stage-pill.current')?.textContent.trim(),
      isPlaying: document.querySelector('.play-button').classList.contains('playing'),
      elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
    })`);
    assert(playbackState.current === "2s" && !playbackState.isPlaying && playbackState.elapsed === 2,
      `The incremental 0.5-2s clue did not finish at 2s (${JSON.stringify(playbackState)}).`);

    await client.evaluate("document.querySelector('.skip-button').click()");
    await delay(850);
    const skipped = await client.evaluate(`(() => {
      const track = document.querySelector('.stage-track').getBoundingClientRect();
      const played = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      const unlocked = document.querySelector('.stage-unlocked-progress').getBoundingClientRect();
      return {
        current: document.querySelector('.stage-pill.current')?.textContent.trim(),
        isPlaying: document.querySelector('.play-button').classList.contains('playing'),
        elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
        playedWidth: played.width,
        unlockedWidth: unlocked.width,
        priorBoundary: document.querySelector('[data-stage="2"]').getBoundingClientRect().right - track.left,
        currentBoundary: document.querySelector('[data-stage="8"]').getBoundingClientRect().right - track.left,
        playheadDecoration: getComputedStyle(document.querySelector('.stage-playback-progress'), '::after').content,
        dividers: [...document.querySelectorAll('.stage-segment.enabled:not(.last-enabled)')]
          .filter((node) => parseFloat(getComputedStyle(node).borderRightWidth) >= 1).length,
      };
    })()`);
    assert(skipped.current === "8s" && !skipped.isPlaying && skipped.elapsed === 2,
      `Skip to 8s was not silent (${JSON.stringify(skipped)}).`);
    assert(Math.abs(skipped.playedWidth - skipped.priorBoundary) <= 3,
      `Silent Skip did not preserve the completed 2s range (${JSON.stringify(skipped)}).`);
    assert(Math.abs(skipped.unlockedWidth - skipped.currentBoundary) <= 3,
      `The 8s range is not fully translucent behind playback (${JSON.stringify(skipped)}).`);
    assert(skipped.playheadDecoration === "none" && skipped.dividers === 4,
      `A playhead blip or missing divider remains (${JSON.stringify(skipped)}).`);

    if (saveArtifacts) {
      const artifactDirectory = path.join(root, ".ui-audit");
      mkdirSync(artifactDirectory, { recursive: true });
      const capture = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeFileSync(path.join(artifactDirectory, "skipped-state.png"), Buffer.from(capture.data, "base64"));
      console.log(`Saved ${path.relative(root, path.join(artifactDirectory, "skipped-state.png"))}`);
    }

    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(350);
    const continued = await client.evaluate(`(() => {
      const track = document.querySelector('.stage-track').getBoundingClientRect();
      const fill = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      return {
        isPlaying: document.querySelector('.play-button').classList.contains('playing'),
        elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
        fillWidth: fill.width,
        priorBoundary: document.querySelector('[data-stage="2"]').getBoundingClientRect().right - track.left,
        currentBoundary: document.querySelector('[data-stage="8"]').getBoundingClientRect().right - track.left,
      };
    })()`);
    assert(continued.isPlaying && continued.elapsed > 2.2 && continued.elapsed < 2.8,
      `Play after Skip did not begin at 2s (${JSON.stringify(continued)}).`);
    assert(continued.fillWidth > continued.priorBoundary && continued.fillWidth < continued.currentBoundary,
      `The manual 2-8s continuation is outside its visual interval (${JSON.stringify(continued)}).`);
    if (saveArtifacts) {
      const artifactDirectory = path.join(root, ".ui-audit");
      const capture = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeFileSync(path.join(artifactDirectory, "incremental-state.png"), Buffer.from(capture.data, "base64"));
      console.log(`Saved ${path.relative(root, path.join(artifactDirectory, "incremental-state.png"))}`);
    }

    await delay(5800);
    const completed = await client.evaluate(`(() => {
      const track = document.querySelector('.stage-track').getBoundingClientRect();
      const fill = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      const endpoint = document.querySelector('[data-stage="8"]').getBoundingClientRect().right - track.left;
      return {
        isPlaying: document.querySelector('.play-button').classList.contains('playing'),
        elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
        fillWidth: fill.width,
        endpoint,
      };
    })()`);
    assert(!completed.isPlaying && completed.elapsed === 8 &&
      Math.abs(completed.fillWidth - completed.endpoint) <= 3,
      `The 2-8s continuation did not finish cleanly at 8s (${JSON.stringify(completed)}).`);

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
    assert(playing.isPlaying && playing.label === "Pause clip playback" && playing.pauseParts === 2,
      `Play button did not switch to the active pause state (${JSON.stringify(playing)}).`);
    assert(Math.abs(playing.pauseX) <= 0.75 && Math.abs(playing.pauseY) <= 0.75,
      `Pause icon is not centered (${playing.pauseX.toFixed(2)}px, ${playing.pauseY.toFixed(2)}px).`);
    assert(playing.progress > 0.02 && playing.progress < 0.12,
      `Playback progress did not advance at the expected rate (${playing.progress}).`);
    assert(playing.elapsed > 0.2 && playing.elapsed < 0.7,
      `The cumulative 8s clip did not begin near song time zero (${playing.elapsed}s).`);
    assert(playing.fillWidth > playing.firstWidth && playing.fillWidth < playing.secondBoundary,
      `Timeline fill did not replay from the first stage boundary (${JSON.stringify(playing)}).`);
    console.log("PASS Skip stays silent; Play continues 2-8s; next Play replays 0-8s");

    const liveVolume = await client.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Volume"]');
      const before = Number(document.querySelector('.stage-playback-progress').dataset.elapsed);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '1.6');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { before };
    })()`);
    await delay(150);
    const liveVolumeState = await client.evaluate(`({
      value: Number(document.querySelector('input[aria-label="Volume"]').value),
      isPlaying: document.querySelector('.play-button').classList.contains('playing'),
      elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
    })`);
    assert(liveVolumeState.value === 1.6 && liveVolumeState.isPlaying
      && liveVolumeState.elapsed > liveVolume.before,
    `Changing volume interrupted active playback (${JSON.stringify(liveVolumeState)}).`);
    console.log("PASS volume changes apply without restarting active playback");

    if (saveArtifacts) {
      const artifactDirectory = path.join(root, ".ui-audit");
      mkdirSync(artifactDirectory, { recursive: true });
      const capture = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeFileSync(path.join(artifactDirectory, "playing-state.png"), Buffer.from(capture.data, "base64"));
      console.log(`Saved ${path.relative(root, path.join(artifactDirectory, "playing-state.png"))}`);
    }

    const pausePoint = await client.evaluate(`(() => {
      const progress = document.querySelector('.stage-playback-progress');
      const elapsed = Number(progress.dataset.elapsed);
      const fillWidth = progress.getBoundingClientRect().width;
      document.querySelector('.play-button').click();
      return { elapsed, fillWidth };
    })()`);
    await delay(100);
    const paused = await client.evaluate(`(() => {
      const fill = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      return {
        playIcon: Boolean(document.querySelector('.play-icon')),
        isPlaying: document.querySelector('.play-button').classList.contains('playing'),
        elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
        fillWidth: fill.width,
      };
    })()`);
    assert(paused.playIcon && !paused.isPlaying,
      `Pause did not return the control to its idle state (${JSON.stringify(paused)}).`);
    assert(Math.abs(paused.elapsed - pausePoint.elapsed) <= 0.1,
      `Pause did not retain the exact elapsed timestamp (${JSON.stringify({ pausePoint, paused })}).`);
    assert(Math.abs(paused.fillWidth - pausePoint.fillWidth) <= 4,
      `Pause did not freeze the opaque timeline at the current position (${JSON.stringify({ pausePoint, paused })}).`);

    if (saveArtifacts) {
      const artifactDirectory = path.join(root, ".ui-audit");
      const capture = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeFileSync(path.join(artifactDirectory, "paused-state.png"), Buffer.from(capture.data, "base64"));
      console.log(`Saved ${path.relative(root, path.join(artifactDirectory, "paused-state.png"))}`);
    }

    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(250);
    const resumed = await client.evaluate(`(() => {
      const fill = document.querySelector('.stage-playback-progress').getBoundingClientRect();
      return {
        isPlaying: document.querySelector('.play-button').classList.contains('playing'),
        elapsed: Number(document.querySelector('.stage-playback-progress').dataset.elapsed),
        fillWidth: fill.width,
      };
    })()`);
    assert(resumed.isPlaying && resumed.elapsed > paused.elapsed + 0.1 && resumed.elapsed < paused.elapsed + 0.6,
      `Play did not resume from the paused timestamp (${JSON.stringify({ paused, resumed })}).`);
    assert(resumed.fillWidth > paused.fillWidth,
      `The opaque timeline did not continue from the paused position (${JSON.stringify({ paused, resumed })}).`);
    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(80);
    console.log("PASS pause retains the exact elapsed position and Play resumes from it");

    await client.evaluate("document.querySelector('.mode-action').click()");
    await delay(100);
    const unlockedAfterReset = await client.evaluate(
      "[...document.querySelectorAll('.stage-pill')].every((button) => !button.disabled)",
    );
    assert(unlockedAfterReset, "A full round reset did not unlock stage settings.");
    console.log("PASS new-round reset unlocks stage settings");

    await client.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Search songs"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Afterglow Avenue');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(100);
    await client.evaluate("document.querySelector('.suggestions button').click()");
    await delay(60);
    await client.evaluate("document.querySelector('.guess-button').click()");
    await delay(160);
    const wonReveal = await client.evaluate(`({
      won: Boolean(document.querySelector('.result-panel.won')),
      title: document.querySelector('.result-panel h1')?.textContent.trim(),
      revealPlaying: document.querySelector('.sr-only')?.textContent.includes('Reveal audio is playing') ?? false,
      hasNext: Boolean(document.querySelector('.result-next-button')),
      hasRetry: Boolean(document.querySelector('.result-retry-button')),
      hasCancel: Boolean(document.querySelector('.auto-reroll-countdown button')),
    })`);
    assert(wonReveal.won && wonReveal.title === "Afterglow Avenue" && wonReveal.revealPlaying
      && wonReveal.hasNext && !wonReveal.hasRetry && wonReveal.hasCancel,
      `A correct guess did not begin reveal playback (${JSON.stringify(wonReveal)}).`);
    if (saveArtifacts) {
      await delay(800);
      const artifactDirectory = path.join(root, ".ui-audit");
      const capture = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeFileSync(path.join(artifactDirectory, "won-state.png"), Buffer.from(capture.data, "base64"));
      console.log(`Saved ${path.relative(root, path.join(artifactDirectory, "won-state.png"))}`);
    }

    await client.evaluate("document.querySelector('.auto-reroll-countdown button').click()");
    await delay(4300);
    const cancelledAutoReroll = await client.evaluate(`({
      status: document.querySelector('.app-shell')?.dataset.status ?? '',
      countdown: Boolean(document.querySelector('.auto-reroll-countdown')),
    })`);
    assert(cancelledAutoReroll.status === "won" && !cancelledAutoReroll.countdown,
      `Cancelling auto reroll did not hold the result (${JSON.stringify(cancelledAutoReroll)}).`);
    await client.evaluate("document.querySelector('.result-next-button').click()");
    await delay(100);
    for (const stage of ["0.5s", "2s", "8s", "15s"]) await clickStage(client, stage);
    await client.evaluate("document.querySelector('.skip-button').click()");
    await delay(160);
    const lostReveal = await client.evaluate(`({
      lost: Boolean(document.querySelector('.result-panel.lost')),
      title: document.querySelector('.result-panel h1')?.textContent.trim(),
      songId: document.querySelector('.app-shell')?.dataset.songId ?? '',
      revealPlaying: document.querySelector('.sr-only')?.textContent.includes('Reveal audio is playing') ?? false,
      countdown: document.querySelector('.auto-reroll-countdown')?.textContent.trim() ?? '',
      hasNext: Boolean(document.querySelector('.result-next-button')),
      hasRetry: Boolean(document.querySelector('.result-retry-button')),
    })`);
    assert(lostReveal.lost && lostReveal.title === "Afterglow Avenue" && lostReveal.revealPlaying
      && lostReveal.countdown.startsWith("Next song in 4s") && lostReveal.hasNext && lostReveal.hasRetry,
      `A final skip did not begin reveal playback (${JSON.stringify(lostReveal)}).`);
    if (saveArtifacts) {
      await delay(800);
      const artifactDirectory = path.join(root, ".ui-audit");
      const capture = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeFileSync(path.join(artifactDirectory, "lost-state.png"), Buffer.from(capture.data, "base64"));
      console.log(`Saved ${path.relative(root, path.join(artifactDirectory, "lost-state.png"))}`);
    }
    console.log("PASS win and loss results restart reveal audio from the prepared song beginning");

    await client.evaluate("document.querySelector('.result-retry-button').click()");
    await delay(100);
    const retryState = await client.evaluate(`({
      status: document.querySelector('.app-shell')?.dataset.status ?? '',
      unlocked: [...document.querySelectorAll('.stage-pill')].every((node) => !node.disabled),
    })`);
    assert(retryState.status === "playing" && retryState.unlocked,
      `The result Retry button did not reset the current round (${JSON.stringify(retryState)}).`);
    await client.evaluate("document.querySelector('.skip-button').click()");
    await delay(160);

    await delay(4300);
    const autoAdvanced = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('.settings-panel .setting-value')]
        .find((node) => node.textContent.trim().startsWith('Auto reroll'));
      const state = {
        status: document.querySelector('.app-shell')?.dataset.status ?? '',
        songId: document.querySelector('.app-shell')?.dataset.songId ?? '',
        countdown: Boolean(document.querySelector('.auto-reroll-countdown')),
        unlocked: [...document.querySelectorAll('.stage-pill')].every((node) => !node.disabled),
      };
      button?.click();
      return state;
    })()`);
    assert(autoAdvanced.status === "playing" && autoAdvanced.songId
      && !autoAdvanced.countdown && autoAdvanced.unlocked,
    `Auto reroll did not start a clean next round (${JSON.stringify(autoAdvanced)}).`);
    console.log("PASS result Retry, Next song, Cancel, and four-second auto reroll controls");

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

    // A phone-sized round view must hold still while a clip plays. Any growth in
    // the scrollable page also matters: on iOS the browser toolbar only
    // collapses on a scrollable page, and it re-expands when media starts,
    // which drags the whole layout down and back up around playback.
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await delay(260);
    await setStageEnabled(client, "8s", true);
    for (const label of ["0.01s", "0.1s", "0.5s", "2s"]) await setStageEnabled(client, label, false);
    await delay(200);
    const phoneGeometry = `(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { top: Math.round(box.top * 100) / 100, height: Math.round(box.height * 100) / 100 };
      };
      return {
        gameContent: rect('.game-content'),
        stageTrack: rect('.stage-track'),
        playButton: rect('.play-button'),
        guessForm: rect('.guess-form'),
        modePanel: rect('.mode-panel'),
        gameCard: rect('.game-card'),
        settingsPanel: rect('.settings-panel'),
        difficultyTabs: rect('.difficulty-tabs'),
        scrollY: Math.round(window.scrollY * 100) / 100,
        innerHeight: window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: Math.round((window.visualViewport?.height ?? 0) * 100) / 100,
        viewportOffsetTop: Math.round((window.visualViewport?.offsetTop ?? 0) * 100) / 100,
        playing: document.querySelector('.play-button')?.classList.contains('playing') ?? false,
      };
    })()`;
    const phoneIdle = await client.evaluate(phoneGeometry);
    await client.evaluate("document.querySelector('.play-button').click()");
    let phonePlaying = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await delay(120);
      const sample = await client.evaluate(phoneGeometry);
      if (sample.playing && Number(await client.evaluate("Number(document.querySelector('.stage-playback-progress').dataset.elapsed)")) > 0) {
        phonePlaying = sample;
        break;
      }
    }
    assert(phonePlaying, "Playback never became active at the 390x844 phone viewport.");
    if (saveArtifacts) {
      const artifactDirectory = path.join(root, ".ui-audit");
      mkdirSync(artifactDirectory, { recursive: true });
      const capture = await client.call("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(artifactDirectory, "phone-playing-state.png"), Buffer.from(capture.data, "base64"));
      console.log(`Saved ${path.relative(root, path.join(artifactDirectory, "phone-playing-state.png"))}`);
    }
    await client.evaluate("document.querySelector('.play-button').click()");
    await delay(220);
    const phoneStopped = await client.evaluate(phoneGeometry);
    console.log(`Phone geometry idle/playing/stopped: ${JSON.stringify({ phoneIdle, phonePlaying, phoneStopped })}`);
    for (const key of ["gameContent", "stageTrack", "playButton", "guessForm"]) {
      const drift = Math.abs(phonePlaying[key].top - phoneIdle[key].top);
      const restored = Math.abs(phoneStopped[key].top - phoneIdle[key].top);
      assert(drift <= 0.5 && restored <= 0.5,
        `${key} moved vertically around playback on a phone viewport (idle ${phoneIdle[key].top}, playing ${phonePlaying[key].top}, stopped ${phoneStopped[key].top}).`);
    }
    assert(phonePlaying.scrollHeight <= phonePlaying.innerHeight + 1,
      `The phone round view is ${phonePlaying.scrollHeight - phonePlaying.innerHeight}px taller than the viewport, so the iOS toolbar can collapse and re-expand around playback (${JSON.stringify(phonePlaying)}).`);
    console.log("PASS phone round view holds still and fits the viewport during playback");

    // Headless Chrome has no collapsing toolbar, so svh, dvh and vh all resolve
    // to the same height here. Re-measuring at a deliberately short viewport is
    // what proves the round still fits once a real toolbar takes its share.
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 660,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await delay(240);
    const shortViewport = await client.evaluate(phoneGeometry);
    assert(shortViewport.scrollHeight <= shortViewport.innerHeight + 1,
      `The round view overflows a 390x660 phone viewport by ${shortViewport.scrollHeight - shortViewport.innerHeight}px (${JSON.stringify(shortViewport)}).`);
    console.log(`PASS round view fits a short 390x660 phone viewport (card ${shortViewport.gameCard.height}px)`);

    // The result screen shares the card, so it has to fit the small viewport
    // too. If it can scroll, the toolbar collapses there and the next round's
    // first Play brings it back, which is the same jump by another route.
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await delay(200);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const status = await client.evaluate("document.querySelector('.app-shell')?.dataset.status");
      if (status !== "playing") break;
      await client.evaluate("document.querySelector('.skip-button')?.click()");
      await delay(130);
    }
    await delay(700);
    const phoneResult = await client.evaluate(phoneGeometry);
    if (saveArtifacts) {
      const artifactDirectory = path.join(root, ".ui-audit");
      mkdirSync(artifactDirectory, { recursive: true });
      const capture = await client.call("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(artifactDirectory, "phone-result-state.png"), Buffer.from(capture.data, "base64"));
      console.log(`Saved ${path.relative(root, path.join(artifactDirectory, "phone-result-state.png"))}`);
    }
    assert(phoneResult.scrollHeight <= phoneResult.innerHeight + 1,
      `The phone result screen overflows the viewport by ${phoneResult.scrollHeight - phoneResult.innerHeight}px (${JSON.stringify(phoneResult)}).`);
    const phoneResultCentering = await client.evaluate(`(() => {
      const card = document.querySelector('.game-card').getBoundingClientRect();
      const artwork = document.querySelector('.result-artwork-wrap')?.getBoundingClientRect();
      const stamp = document.querySelector('.result-stamp')?.getBoundingClientRect();
      if (!artwork || !stamp) return null;
      return {
        groupTop: Math.round(artwork.top),
        groupBottom: Math.round(stamp.bottom),
        offset: Math.round(((artwork.top + stamp.bottom) / 2) - (card.top + card.height / 2)),
      };
    })()`);
    console.log(`Phone result group vs card centre: ${JSON.stringify(phoneResultCentering)}`);
    assert(phoneResultCentering && Math.abs(phoneResultCentering.offset) <= 16,
      `The phone result group is not centred in the game card (${JSON.stringify(phoneResultCentering)}).`);
    console.log("PASS phone result screen fits the viewport and centres its result group");
    // Playback locked the stage pills, so reroll before restoring the defaults
    // the remaining checks expect.
    await client.evaluate("document.querySelector('.mode-action').click()");
    await delay(220);
    for (const label of ["0.01s", "0.1s", "0.5s", "2s"]) await setStageEnabled(client, label, true);
    await setStageEnabled(client, "0.01s", false);
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 1918,
      height: 1079,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(200);

    const artworkFixtures = ["#ff3158", "#2f7cff"].map((color, index) => (
      `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/><text x="32" y="40" text-anchor="middle" fill="white" font-size="24">${index + 1}</text></svg>`).toString("base64")}`
    ));
    const artworkTransitionCatalog = artworkFixtures.map((artwork, index) => ({
      id: `artwork-transition-${index + 1}`,
      title: `Artwork Transition ${index + 1}`,
      artist: `Fixture Artist ${index + 1}`,
      aliases: [],
      artistAliases: [],
      releaseYear: 2026,
      genres: ["test"],
      difficulty: "easy",
      familiarity: 80,
      artwork,
      audio: { kind: "synth", notes: [220 + index * 110, 330 + index * 110] },
    }));
    writeFileSync(catalogFile, `${JSON.stringify(artworkTransitionCatalog, null, 2)}\n`);
    await client.call("Page.navigate", { url: `http://127.0.0.1:${appPort}/` });
    await waitForPage(client);
    async function loseArtworkFixture() {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const status = await client.evaluate("document.querySelector('.app-shell')?.dataset.status");
        if (status !== "playing") return;
        await client.evaluate("document.querySelector('.skip-button')?.click()");
        await delay(60);
      }
      throw new Error("Artwork transition fixture did not reach its result screen.");
    }
    async function artworkResultState() {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const state = await client.evaluate(`(() => {
          const shell = document.querySelector('.app-shell');
          const image = document.querySelector('.result-panel img.artwork');
          return {
            songId: shell?.dataset.songId ?? '',
            artworkId: image?.dataset.artworkId ?? '',
            src: image?.src ?? '',
            loaded: Boolean(image?.complete && image?.naturalWidth > 0),
          };
        })()`);
        if (state.loaded) return state;
        await delay(40);
      }
      throw new Error("Artwork transition fixture did not load its result image.");
    }
    await loseArtworkFixture();
    const firstArtwork = await artworkResultState();
    await client.evaluate("document.querySelector('.result-next-button').click()");
    await delay(80);
    await loseArtworkFixture();
    const secondArtwork = await artworkResultState();
    assert(firstArtwork.songId === firstArtwork.artworkId
      && secondArtwork.songId === secondArtwork.artworkId
      && firstArtwork.songId !== secondArtwork.songId
      && firstArtwork.src !== secondArtwork.src,
    `Result artwork did not follow the current song across Next song (${JSON.stringify({ firstArtwork, secondArtwork })}).`);
    console.log("PASS result artwork changes with the current song across consecutive rounds");

    if (verifyHostedPlayback) {
      assert(originalReviewCatalog, "Run npm run review:r2 before npm run verify:hosted.");
      const hostedSongs = JSON.parse(originalReviewCatalog.toString("utf8"));
      const hostedSong = hostedSongs.find((song) => song.id === hostedSongId && song.audio?.kind === "hosted")
        ?? hostedSongs.find((song) => song.clueGainDb > 0 && song.audio?.kind === "hosted")
        ?? hostedSongs.find((song) => song.audio?.kind === "hosted");
      assert(hostedSong, "The generated review catalogue has no hosted R2 song.");
      if (requestedHostedSongId) {
        assert(hostedSong.id === requestedHostedSongId,
          `Requested hosted smoke song is unavailable: ${requestedHostedSongId}.`);
      }
      writeFileSync(reviewCatalogFile, `${JSON.stringify([hostedSong], null, 2)}\n`);
      await client.call("Page.navigate", { url: `http://127.0.0.1:${appPort}/?reviewSong=${encodeURIComponent(hostedSong.id)}` });
      await waitForPage(client);
      await client.evaluate(`(() => {
        [...document.querySelectorAll('.setting-value')]
          .find((button) => button.textContent.trim() === 'From the start')?.click();
        window.__songlessRevealStarts = [];
        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function songlessObservedPlay(...args) {
          window.__songlessRevealStarts.push({ src: this.currentSrc || this.src, currentTime: this.currentTime });
          return originalPlay.apply(this, args);
        };
      })()`);
      await setStageEnabled(client, "2s", true);
      await setStageEnabled(client, "0.1s", false);
      await setStageEnabled(client, "0.5s", false);
      await client.evaluate("document.querySelector('.play-button').click()");
      await delay(80);
      const initialHostedState = await client.evaluate(`({
        playing: document.querySelector('.play-button')?.classList.contains('playing') ?? false,
        loading: document.querySelector('.play-button')?.classList.contains('loading') ?? false,
        busy: document.querySelector('.play-button')?.getAttribute('aria-busy') === 'true',
        error: document.querySelector('.audio-error')?.textContent.trim() ?? '',
      })`);
      assert((initialHostedState.playing || (initialHostedState.loading && initialHostedState.busy))
        && !initialHostedState.error,
      `Hosted playback gave no playing/loading feedback (${JSON.stringify(initialHostedState)}).`);
      let activePlayback;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        activePlayback = await client.evaluate(`({
          playing: document.querySelector('.play-button')?.classList.contains('playing') ?? false,
          elapsed: Number(document.querySelector('.stage-playback-progress')?.dataset.elapsed ?? 0),
          error: document.querySelector('.audio-error')?.textContent.trim() ?? '',
        })`);
        if ((activePlayback.playing && activePlayback.elapsed > 0) || activePlayback.error) break;
        await delay(250);
      }
      assert(activePlayback.playing && activePlayback.elapsed > 0 && !activePlayback.error,
        `The real hosted clue did not play through Web Audio (${JSON.stringify(activePlayback)}).`);
      await client.evaluate("document.querySelector('.play-button').click()");
      await delay(80);
      const pausedElapsed = await client.evaluate("Number(document.querySelector('.stage-playback-progress')?.dataset.elapsed ?? 0)");
      assert(pausedElapsed > 0, "The hosted clue did not retain its paused timestamp.");
      const enabledCount = await client.evaluate("document.querySelectorAll('.stage-pill[aria-pressed=\"true\"]').length");
      for (let index = 0; index < enabledCount; index += 1) {
        await client.evaluate("document.querySelector('.skip-button')?.click()");
        await delay(100);
      }
      await delay(700);
      const hostedReveal = await client.evaluate(`({
        lost: Boolean(document.querySelector('.result-panel.lost')),
        revealPlaying: document.querySelector('.sr-only')?.textContent.includes('Reveal audio is playing') ?? false,
        error: document.querySelector('.audio-error')?.textContent.trim() ?? '',
        artworkId: document.querySelector('.result-panel img.artwork')?.dataset.artworkId ?? '',
        artworkSrc: document.querySelector('.result-panel img.artwork')?.currentSrc ?? '',
        artworkLoaded: (document.querySelector('.result-panel img.artwork')?.naturalWidth ?? 0) > 0,
        mediaStarts: window.__songlessRevealStarts ?? [],
      })`);
      assert(hostedReveal.lost && hostedReveal.revealPlaying && !hostedReveal.error,
        `The real hosted full-song reveal did not restart (${JSON.stringify(hostedReveal)}).`);
      assert(hostedReveal.artworkId === hostedSong.id && hostedReveal.artworkSrc === hostedSong.artwork
        && hostedReveal.artworkLoaded,
      `The real hosted result did not render its assigned artwork (${JSON.stringify(hostedReveal)}).`);
      if (saveArtifacts) {
        const artifactDirectory = path.join(root, ".ui-audit");
        mkdirSync(artifactDirectory, { recursive: true });
        const capture = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
        const artifactFile = path.join(artifactDirectory, `hosted-${hostedSong.id}-lost-state.png`);
        writeFileSync(artifactFile, Buffer.from(capture.data, "base64"));
        console.log(`Saved ${path.relative(root, artifactFile)}`);
      }
      const revealStart = hostedReveal.mediaStarts.at(-1)?.currentTime;
      const expectedRevealStart = (hostedSong.startAtMs ?? 0) / 1000;
      assert(Number.isFinite(revealStart) && Math.abs(revealStart - expectedRevealStart) <= 0.2,
        `The hosted reveal inherited clue time instead of restarting at game-time zero (${JSON.stringify({ revealStart, expectedRevealStart })}).`);
      console.log(`PASS real R2 clue, assigned artwork, and full-song reveal restart (${hostedSong.id})`);

      // The shortest stage is the one that breaks when a start lands early, and
      // it is too brief to judge by watching the UI. Decode the deployed clue
      // with the browser's own MP3 decoder, so its priming is included, and
      // measure the exact 0.1 second window the player would hear.
      const clueUrl = hostedSong.audio.clueSrc;
      assert(clueUrl, `The hosted smoke song ${hostedSong.id} has no clue asset URL.`);
      const shortestClue = await client.evaluate(`(async () => {
        const context = new (window.AudioContext ?? window.webkitAudioContext)();
        const response = await fetch(${JSON.stringify(clueUrl)});
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const samples = buffer.getChannelData(0);
        const rate = buffer.sampleRate;
        const levelDb = (fromMs, lengthMs) => {
          const start = Math.max(0, Math.round((fromMs / 1000) * rate));
          const end = Math.min(samples.length, start + Math.round((lengthMs / 1000) * rate));
          if (end <= start) return null;
          let sum = 0;
          for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
          return 20 * Math.log10(Math.max(Math.sqrt(sum / (end - start)), 1e-9));
        };
        const startMs = ${Number(hostedSong.startAtMs ?? 0)};
        await context.close();
        return {
          startMs,
          // The same five 20 ms sub-windows the offline gate judges, so this is
          // a confirmation of that gate rather than a weaker average.
          subWindowDbs: [0, 1, 2, 3, 4].map((slot) => levelDb(startMs + slot * 20, 20)),
          bodyDb: levelDb(5000, 15000),
          durationMs: Math.round(buffer.duration * 1000),
        };
      })()`);
      const clueGainDb = hostedSong.clueGainDb ?? 0;
      const relativeDbs = shortestClue.subWindowDbs.map((db) => db + clueGainDb - shortestClue.bodyDb);
      const audibleSubWindows = relativeDbs.filter((db) => db >= -26).length;
      console.log(`Shortest hosted clue for ${hostedSong.id} at ${shortestClue.startMs}ms: ${audibleSubWindows}/5 sub-windows audible, [${relativeDbs.map((db) => db.toFixed(1)).join(", ")}] dB relative to the song body`);
      assert(audibleSubWindows >= 4,
        `The deployed 0.1s clue for ${hostedSong.id} opens on inaudible audio: only ${audibleSubWindows} of 5 sub-windows reach its body level (${JSON.stringify(shortestClue)}).`);
      console.log(`PASS deployed 0.1s clue is audible in the browser decoder (${hostedSong.id})`);

      // Clues must not use HTMLAudioElement. WebKit's MediaElementSource drops
      // the first 150-400ms after play(), which is the whole 0.1s stage, and
      // iOS registers a Now Playing session that resizes browser chrome.
      await client.evaluate(`(() => {
        window.__songlessClueMediaPlays = 0;
        window.__songlessBufferStarts = [];
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function tracedPlay(...args) {
          window.__songlessClueMediaPlays += 1;
          return play.apply(this, args);
        };
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function tracedStart(when, offset, duration) {
          window.__songlessBufferStarts.push({ offset, duration, at: performance.now() });
          return start.apply(this, arguments);
        };
      })()`);
      // Reroll first: the earlier playback locked the stage pills for that round.
      await client.evaluate("document.querySelector('.mode-action').click()");
      await delay(500);
      await setStageEnabled(client, "0.1s", true);
      for (const label of ["0.01s", "0.5s", "2s", "8s", "15s"]) await setStageEnabled(client, label, false);
      const clueStages = await client.evaluate(`[...document.querySelectorAll('.stage-pill[aria-pressed="true"]')].map((node) => node.textContent.trim())`);
      assert(clueStages.length === 1 && clueStages[0] === "0.1s",
        `The clue-duration check needs only the 0.1s stage enabled (${JSON.stringify(clueStages)}).`);
      await client.evaluate("window.__songlessClueMediaPlays = 0; window.__songlessBufferStarts = [];");
      await client.evaluate("document.querySelector('.play-button').click()");
      let clueState;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        clueState = await client.evaluate(`({
          playing: document.querySelector('.play-button')?.classList.contains('playing') ?? false,
          loading: document.querySelector('.play-button')?.classList.contains('loading') ?? false,
          elapsed: Number(document.querySelector('.stage-playback-progress')?.dataset.elapsed ?? 0),
          error: document.querySelector('.audio-error')?.textContent.trim() ?? '',
          mediaPlays: window.__songlessClueMediaPlays ?? 0,
          bufferStarts: window.__songlessBufferStarts ?? [],
        })`);
        if ((clueState.playing && clueState.elapsed > 0) || clueState.error || clueState.bufferStarts.length > 0) break;
        await delay(250);
      }
      const scheduled = clueState.bufferStarts.at(-1);
      const expectedOffset = (hostedSong.startAtMs ?? 0) / 1000;
      console.log(`0.1s hosted clue scheduled BufferSource offset=${scheduled?.offset} duration=${scheduled?.duration} mediaPlays=${clueState.mediaPlays}`);
      assert(clueState.mediaPlays === 0,
        `A 0.1s hosted clue must not start an HTMLAudioElement on iOS (${JSON.stringify(clueState)}).`);
      assert(scheduled && Math.abs(scheduled.duration - 0.1) <= 0.000001 && Math.abs(scheduled.offset - expectedOffset) <= 0.000001,
        `A 0.1s hosted clue must be scheduled as an exact PCM range (${JSON.stringify({ scheduled, expectedOffset, clueState })}).`);
      assert(!clueState.error,
        `The 0.1s hosted clue failed to play (${JSON.stringify(clueState)}).`);
      console.log("PASS the 0.1s hosted clue is a decoded buffer, not a media element");
    }

    writeFileSync(reviewCatalogFile, `${JSON.stringify([{
      id: "hosted-review-fixture",
      title: "A Deliberately Long International Review Title",
      artist: "Primary Artist, Featured Artist",
      aliases: ["Romanized Review Title"],
      artistAliases: [],
      album: "A Long Album Name for Result Layout",
      spotifyUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
      releaseYear: 2024,
      genres: ["pop"],
      difficulty: "easy",
      familiarity: 85,
      artwork: "/missing-artwork-fixture.jpg",
      audio: {
        kind: "hosted",
        clueSrc: "https://media.invalid/audio/clues/hosted-review-fixture.mp3",
        fullSrc: "https://media.invalid/audio/full/hosted-review-fixture.mp3",
        durationMs: 213573,
      },
    }], null, 2)}\n`);
    await client.call("Page.navigate", { url: `http://127.0.0.1:${appPort}/?reviewSong=hosted-review-fixture` });
    await waitForPage(client);
    await delay(150);
    const hostedLayout = await client.evaluate(`(() => {
      return {
        spotifySetting: Boolean(document.querySelector('.spotify-setting')),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    })()`);
    assert(!hostedLayout.spotifySetting,
      `The removed Spotify runtime setting reappeared (${JSON.stringify(hostedLayout)}).`);
    assert(hostedLayout.overflow <= 1,
      `Hosted settings broke the narrow layout (${JSON.stringify(hostedLayout)}).`);

    await client.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Search songs"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Romanized Review Title');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(80);
    await client.evaluate("document.querySelector('.suggestions button').click()");
    await delay(40);
    await client.evaluate("document.querySelector('.guess-button').click()");
    await delay(120);
    const hostedResult = await client.evaluate(`({
      title: document.querySelector('.result-panel h1')?.textContent.trim(),
      artist: document.querySelector('.result-artist')?.textContent.replace(/\\s+/g, ' ').trim(),
      metadataHref: document.querySelector('.result-source-link')?.href ?? "",
      artworkFallback: Boolean(document.querySelector('.result-panel .artwork.fallback')),
      artworkId: document.querySelector('.result-panel .artwork')?.dataset.artworkId ?? "",
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    })`);
    assert(hostedResult.title === "A Deliberately Long International Review Title" &&
      hostedResult.artist.includes("Primary Artist, Featured Artist") &&
      hostedResult.artist.includes("A Long Album Name for Result Layout") &&
      hostedResult.metadataHref.includes("open.spotify.com/track/") && hostedResult.artworkFallback &&
      hostedResult.artworkId === "hosted-review-fixture",
    `Hosted result metadata or artwork fallback is incomplete (${JSON.stringify(hostedResult)}).`);
    assert(hostedResult.overflow <= 1, `Hosted result overflows the narrow viewport (${JSON.stringify(hostedResult)}).`);
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 1918,
      height: 1079,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(160);
    const hostedDesktop = await client.evaluate(`(() => {
      const settingPanel = document.querySelector('.settings-panel').getBoundingClientRect();
      const gameCard = document.querySelector('.game-card').getBoundingClientRect();
      const result = document.querySelector('.result-panel').getBoundingClientRect();
      const artwork = document.querySelector('.result-artwork-wrap')?.getBoundingClientRect();
      const stamp = document.querySelector('.result-stamp')?.getBoundingClientRect();
      return {
        panelTop: settingPanel.top,
        panelBottom: settingPanel.bottom,
        resultCenterOffset: (result.left + result.width / 2) - (gameCard.left + gameCard.width / 2),
        resultVerticalOffset: artwork && stamp
          ? Math.round(((artwork.top + stamp.bottom) / 2) - (gameCard.top + gameCard.height / 2))
          : null,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    })()`);
    assert(hostedDesktop.panelTop >= 0 && hostedDesktop.panelBottom <= 1079 && hostedDesktop.overflow <= 1,
      `Hosted settings do not fit the desktop viewport (${JSON.stringify(hostedDesktop)}).`);
    assert(Math.abs(hostedDesktop.resultCenterOffset) <= 1,
      `Hosted result group is not centered in the game card (${JSON.stringify(hostedDesktop)}).`);
    console.log(`Desktop result group vs card centre: ${hostedDesktop.resultVerticalOffset}px`);
    console.log("PASS hosted source and long result metadata fit narrow and desktop layouts");

    console.log("UI audit passed.");
  } finally {
    writeFileSync(catalogFile, originalCatalog);
    if (originalReviewCatalog === null) rmSync(reviewCatalogFile, { force: true });
    else writeFileSync(reviewCatalogFile, originalReviewCatalog);
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
