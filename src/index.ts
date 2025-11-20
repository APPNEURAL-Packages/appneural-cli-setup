import { Command } from "commander";
import { registerSetupCommands } from "./commands/setup.js";

export default function register(program: Command): void {
  registerSetupCommands(program);
}
