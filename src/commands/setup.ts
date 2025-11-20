import { Command } from "commander";
import { logger } from "@appneural/cli-shared";
import { withTelemetry } from "@appneural/cli-shared";
import { withSpinner } from "@appneural/cli-shared";
import { applyRoleSetup, runLocalEnvironmentSetup } from "../services/setup.service.js";
import { ValidationError } from "@appneural/cli-shared";

const SUPPORTED_ROLES = ["backend-dev", "frontend-dev", "mobile-dev", "fullstack-dev", "devops"];

export function registerSetupCommands(program: Command): void {
  const setup = program.command("setup").description("APPNEURAL setup automation");

  setup
    .command("role <role>")
    .description("Apply an APPNEURAL role profile from appneural.roles.yaml")
    .action((role: string) =>
      withTelemetry("setup:role", async () => {
        if (!SUPPORTED_ROLES.includes(role)) {
          throw new ValidationError("APPNEURAL role unsupported", { role, supported: SUPPORTED_ROLES });
        }

        const result = await withSpinner("Configuring APPNEURAL role", async () => applyRoleSetup(role));
        logger.success(`APPNEURAL role '${result.role}' applied`);
        logger.info(`APPNEURAL templates loaded: ${result.templates.join(", ") || "none"}`);
        logger.info(`APPNEURAL snippets loaded: ${result.snippets.join(", ") || "none"}`);
        logger.info(`APPNEURAL shortcuts registered: ${result.shortcuts.length}`);
      })
    );

  setup
    .command("local")
    .description("Provision the local APPNEURAL development environment")
    .action(() =>
      withTelemetry("setup:local", async () => {
        const summary = await withSpinner(
          "Bootstrapping APPNEURAL local environment",
          runLocalEnvironmentSetup,
          "ignite"
        );

        logger.success(`APPNEURAL dependencies installed via ${summary.packageManager}`);
        logger.info(`APPNEURAL .env generated: ${summary.envGenerated ? "yes" : "no source"}`);
        logger.info(`APPNEURAL docker services: ${summary.dockerServices.join(", ")}`);
        logger.info(
          `APPNEURAL migrations: ${summary.migrationsExecuted ? "executed" : "skipped"}, seeders: ${summary.seedersExecuted ? "executed" : "skipped"}`
        );
        summary.healthChecks.forEach((check) => {
          logger.info(
            `APPNEURAL health ${check.url} => ${check.healthy ? "healthy" : "unavailable"}${
              check.status ? ` (status ${check.status})` : ""
            }`
          );
        });
        logger.success("APPNEURAL local environment ready");
      })
    );
}
