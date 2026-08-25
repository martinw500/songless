import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";

function feedbackApiPlugin(): Plugin {
  const attach = (server: { middlewares: { use: Function } }) => {
    server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const path = req.url?.split("?")[0] ?? "";
      if (path !== "/api/feedback") {
        next();
        return;
      }
      try {
        const { default: handler } = await import("./api/feedback.ts");
        await handler(req, res);
      } catch (error) {
        console.error("The local feedback relay failed.", error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Feedback could not be delivered." }));
        }
      }
    });
  };

  return {
    name: "feedback-api",
    configureServer(server) {
      attach(server);
    },
    configurePreviewServer(server) {
      attach(server);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const webhook = (env.DISCORD_WEBHOOK_URL || env.VITE_DISCORD_WEBHOOK_URL || "").trim();
  if (webhook) process.env.DISCORD_WEBHOOK_URL = webhook;

  return {
    plugins: [react(), feedbackApiPlugin()],
    server: {
      host: "127.0.0.1",
      port: 4173,
    },
  };
});
