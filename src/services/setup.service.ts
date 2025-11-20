import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import os from "os";
import { execa } from "execa";
import YAML from "yaml";
import { logger, ensureDir, copyDirectory, pathExists } from "@appneural/cli-shared";
import { AppneuralError, ValidationError } from "@appneural/cli-shared";
import { getCliRoot, getGlobalConfigDir, getGlobalTemplatesDir } from "@appneural/cli-shared";

const WORKSPACE_ROOT = process.cwd();
const ROLES_FILE = path.join(WORKSPACE_ROOT, "appneural.roles.yaml");
const CONFIG_FILE = path.join(WORKSPACE_ROOT, "appneural.config.json");
const INTERNAL_TEMPLATE_ROOT = path.join(getCliRoot(), "templates");
const INTERNAL_SNIPPET_ROOT = path.join(INTERNAL_TEMPLATE_ROOT, "snippets");
const GLOBAL_TEMPLATE_ROOT = getGlobalTemplatesDir();
const GLOBAL_SNIPPET_ROOT = path.join(getGlobalConfigDir(), "snippets");

const REQUIRED_TOOLS: Array<{ name: string; args?: string[]; required: boolean }> = [
  { name: "node", args: ["--version"], required: true },
  { name: "npm", args: ["--version"], required: true },
  { name: "pnpm", args: ["--version"], required: false },
  { name: "yarn", args: ["--version"], required: false },
  { name: "docker", args: ["--version"], required: true }
];

const DEFAULT_HEALTH_ENDPOINTS = [
  "http://localhost:3000/health",
  "http://localhost:4000/health",
  "http://localhost:8080/ready"
];

const DEFAULT_ROLES: Record<string, RoleDefinition> = {
  "backend-dev": {
    description: "APPNEURAL backend focused engineer stack",
    shortcuts: [
      { name: "svc", command: "appneural microservice create", description: "Scaffold Nest microservice" },
      { name: "repo", command: "appneural repo create", description: "Create GitHub repository" }
    ],
    templates: ["nest-service/basic", "dto-crud/basic", "rest-api-module/core"],
    snippets: ["database-connection"],
    instructions: [
      "Use APPNEURAL microservice generator for each bounded context",
      "Follow the DTO CRUD template to keep transports consistent"
    ],
    config: {
      stack: "nest",
      healthChecks: DEFAULT_HEALTH_ENDPOINTS
    }
  },
  "frontend-dev": {
    description: "APPNEURAL frontend experience",
    shortcuts: [
      { name: "ui", command: "appneural ui add", description: "Add UI component" },
      { name: "page", command: "appneural generate react-page/dashboard", description: "Generate React page" }
    ],
    templates: ["react-page/dashboard"],
    snippets: ["apollo-client"],
    instructions: [
      "Leverage APPNEURAL UI kit for consistent look",
      "Use the page generator for dashboards"
    ],
    config: {
      stack: "react"
    }
  },
  "mobile-dev": {
    description: "APPNEURAL mobile stack",
    shortcuts: [
      { name: "rn", command: "appneural new react-native-app", description: "Create RN app" },
      { name: "sdk", command: "appneural sdk generate mobile", description: "Generate mobile SDK" }
    ],
    templates: ["react-page/mobile"],
    snippets: ["mobile-storage"],
    instructions: [
      "Use APPNEURAL Blueprint generator for RN apps",
      "Sync native modules through SDK command"
    ],
    config: {
      stack: "react-native"
    }
  },
  "fullstack-dev": {
    description: "APPNEURAL fullstack role",
    shortcuts: [
      { name: "fullstack", command: "appneural new webapp", description: "Create webapp" },
      { name: "svc", command: "appneural new nest-microservice", description: "Create Nest service" }
    ],
    templates: ["nest-service/basic", "react-page/dashboard"],
    snippets: ["fullstack-testing"],
    instructions: [
      "Generate paired backend/frontend modules",
      "Adopt shared DTO patterns"
    ],
    config: {
      stack: "fullstack"
    }
  },
  devops: {
    description: "APPNEURAL DevOps automation",
    shortcuts: [
      { name: "cloud", command: "appneural cloud init --provider aws", description: "Init infra" },
      { name: "plan", command: "appneural cloud plan dev", description: "Plan dev env" }
    ],
    templates: ["microservice-basic/base"],
    snippets: ["cicd-pipeline"],
    instructions: [
      "Keep infra modules in sync across envs",
      "Use the quality suite before shipping"
    ],
    config: {
      stack: "devops",
      healthChecks: DEFAULT_HEALTH_ENDPOINTS
    }
  }
};

interface RoleManifestFile {
  roles?: Record<string, RoleDefinition>;
}

export interface RoleShortcut {
  name: string;
  command: string;
  description?: string;
}

interface RoleDefinition {
  description?: string;
  shortcuts?: RoleShortcut[];
  templates?: string[];
  snippets?: string[];
  instructions?: string[];
  config?: Record<string, unknown>;
}

interface AppneuralConfig {
  role?: string;
  shortcuts?: RoleShortcut[];
  instructions?: string[];
  templates?: string[];
  snippets?: string[];
  settings?: Record<string, unknown>;
  healthChecks?: string[];
  history?: Array<{ role: string; appliedAt: string }>;
  updatedAt?: string;
}

export interface RoleSetupResult {
  role: string;
  shortcuts: RoleShortcut[];
  templates: string[];
  snippets: string[];
  instructions: string[];
}

export interface LocalSetupResult {
  packageManager: PackageManager;
  envGenerated: boolean;
  dockerServices: string[];
  migrationsExecuted: boolean;
  seedersExecuted: boolean;
  healthChecks: Array<{ url: string; healthy: boolean; status?: number }>;
}

type PackageManager = "pnpm" | "yarn" | "npm";

type DockerComposeCommand = "docker" | "docker-compose";

async function readAppneuralConfig(): Promise<AppneuralConfig> {
  if (!(await pathExists(CONFIG_FILE))) {
    return {};
  }
  const content = await fs.readFile(CONFIG_FILE, "utf-8");
  return JSON.parse(content) as AppneuralConfig;
}

async function writeAppneuralConfig(config: AppneuralConfig): Promise<void> {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

async function loadRolesManifest(): Promise<Record<string, RoleDefinition>> {
  if (!(await pathExists(ROLES_FILE))) {
    return DEFAULT_ROLES;
  }
  const raw = await fs.readFile(ROLES_FILE, "utf-8");
  const parsed = YAML.parse(raw) as RoleManifestFile;
  if (!parsed?.roles || Object.keys(parsed.roles).length === 0) {
    return DEFAULT_ROLES;
  }
  return parsed.roles;
}

async function copyTemplateToGlobal(role: string, templateKey: string): Promise<void> {
  const source = path.join(INTERNAL_TEMPLATE_ROOT, templateKey);
  if (!(await pathExists(source))) {
    throw new ValidationError("APPNEURAL role template missing", { templateKey });
  }
  const destination = path.join(GLOBAL_TEMPLATE_ROOT, "roles", role, templateKey);
  await copyDirectory(source, destination);
}

async function copySnippetToGlobal(snippetKey: string): Promise<void> {
  const source = path.join(INTERNAL_SNIPPET_ROOT, `${snippetKey}.md`);
  if (!(await pathExists(source))) {
    throw new ValidationError("APPNEURAL snippet missing", { snippetKey });
  }
  const destination = path.join(GLOBAL_SNIPPET_ROOT, `${snippetKey}.md`);
  await ensureDir(path.dirname(destination));
  await fs.copyFile(source, destination);
}

export async function applyRoleSetup(role: string): Promise<RoleSetupResult> {
  const manifest = await loadRolesManifest();
  const definition = manifest[role];
  if (!definition) {
    throw new ValidationError("APPNEURAL role not found", { role });
  }

  await ensureDir(GLOBAL_TEMPLATE_ROOT);
  await ensureDir(GLOBAL_SNIPPET_ROOT);

  for (const templateKey of definition.templates ?? []) {
    await copyTemplateToGlobal(role, templateKey);
  }
  for (const snippetKey of definition.snippets ?? []) {
    await copySnippetToGlobal(snippetKey);
  }

  const currentConfig = await readAppneuralConfig();
  const updatedHistory = currentConfig.history ?? [];
  updatedHistory.push({ role, appliedAt: new Date().toISOString() });

  const nextConfig: AppneuralConfig = {
    ...currentConfig,
    role,
    shortcuts: definition.shortcuts ?? [],
    instructions: definition.instructions ?? [],
    templates: definition.templates ?? [],
    snippets: definition.snippets ?? [],
    settings: {
      ...(currentConfig.settings ?? {}),
      ...(definition.config ?? {})
    },
    healthChecks: (definition.config?.healthChecks as string[] | undefined) ?? currentConfig.healthChecks,
    history: updatedHistory,
    updatedAt: new Date().toISOString()
  };

  await writeAppneuralConfig(nextConfig);

  (definition.instructions ?? []).forEach((instruction, index) => {
    logger.info(`APPNEURAL role instruction ${index + 1}: ${instruction}`);
  });

  (definition.shortcuts ?? []).forEach((shortcut) => {
    logger.info(
      `APPNEURAL shortcut '${shortcut.name}' => ${shortcut.command}${shortcut.description ? ` (${shortcut.description})` : ""}`
    );
  });

  return {
    role,
    shortcuts: definition.shortcuts ?? [],
    templates: definition.templates ?? [],
    snippets: definition.snippets ?? [],
    instructions: definition.instructions ?? []
  };
}

async function isCommandAvailable(command: string, args: string[] = ["--version"]): Promise<boolean> {
  try {
    await execa(command, args, { stdio: "pipe" });
    return true;
  } catch (_error) {
    return false;
  }
}

async function verifyDockerCompose(): Promise<DockerComposeCommand> {
  try {
    await execa("docker", ["compose", "version"], { stdio: "pipe" });
    return "docker";
  } catch (_error) {
    await execa("docker-compose", ["--version"], { stdio: "pipe" });
    return "docker-compose";
  }
}

async function detectPackageManager(): Promise<PackageManager> {
  const pnpmLock = path.join(WORKSPACE_ROOT, "pnpm-lock.yaml");
  const yarnLock = path.join(WORKSPACE_ROOT, "yarn.lock");
  if (await pathExists(pnpmLock)) {
    return (await isCommandAvailable("pnpm")) ? "pnpm" : "npm";
  }
  if (await pathExists(yarnLock)) {
    return (await isCommandAvailable("yarn")) ? "yarn" : "npm";
  }
  return "npm";
}

async function installDependencies(manager: PackageManager): Promise<void> {
  if (manager === "pnpm") {
    await execa("pnpm", ["install"], { cwd: WORKSPACE_ROOT, stdio: "inherit" });
    return;
  }
  if (manager === "yarn") {
    await execa("yarn", ["install"], { cwd: WORKSPACE_ROOT, stdio: "inherit" });
    return;
  }
  await execa("npm", ["install"], { cwd: WORKSPACE_ROOT, stdio: "inherit" });
}

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .forEach((line) => {
      const [key, ...rest] = line.split("=");
      result[key] = rest.join("=");
    });
  return result;
}

function serializeEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(os.EOL);
}

function createSecret(length = 32): string {
  return crypto.randomBytes(length).toString("hex").slice(0, length * 2);
}

async function generateEnvFile(): Promise<boolean> {
  const examplePath = path.join(WORKSPACE_ROOT, ".env.example");
  const envPath = path.join(WORKSPACE_ROOT, ".env");

  if (!(await pathExists(examplePath))) {
    return false;
  }

  const example = await fs.readFile(examplePath, "utf-8");
  const parsed = parseEnv(example);
  parsed.JWT_SECRET = createSecret(32);
  parsed.ENCRYPTION_KEY = createSecret(32);
  await fs.writeFile(envPath, serializeEnv(parsed), "utf-8");
  return true;
}

async function runScriptIfPresent(manager: PackageManager, script: string): Promise<boolean> {
  try {
    if (manager === "pnpm") {
      await execa("pnpm", ["run", script, "--if-present"], { cwd: WORKSPACE_ROOT, stdio: "inherit" });
      return true;
    }
    if (manager === "yarn") {
      await execa("yarn", ["run", script], { cwd: WORKSPACE_ROOT, stdio: "inherit" });
      return true;
    }
    await execa("npm", ["run", script, "--if-present"], { cwd: WORKSPACE_ROOT, stdio: "inherit" });
    return true;
  } catch (_error) {
    logger.warn(`APPNEURAL script '${script}' not available`);
    return false;
  }
}

async function startDockerServices(composeCommand: DockerComposeCommand): Promise<string[]> {
  const args = composeCommand === "docker" ? ["compose", "up", "-d", "db", "redis", "mq"] : ["up", "-d", "db", "redis", "mq"];
  await execa(composeCommand, args, { cwd: WORKSPACE_ROOT, stdio: "inherit" });
  return ["db", "redis", "mq"];
}

async function performHealthChecks(): Promise<Array<{ url: string; healthy: boolean; status?: number }>> {
  const config = await readAppneuralConfig();
  const endpoints = config.healthChecks?.length ? config.healthChecks : DEFAULT_HEALTH_ENDPOINTS;
  const results: Array<{ url: string; healthy: boolean; status?: number }> = [];

  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      results.push({ url, healthy: response.ok, status: response.status });
    } catch (_error) {
      results.push({ url, healthy: false });
    }
  }

  return results;
}

export async function runLocalEnvironmentSetup(): Promise<LocalSetupResult> {
  for (const tool of REQUIRED_TOOLS) {
    const available = await isCommandAvailable(tool.name, tool.args);
    if (!available && tool.required) {
      throw new AppneuralError(`APPNEURAL requires ${tool.name} to be installed`);
    }
    if (!available) {
      logger.warn(`APPNEURAL optional tool missing: ${tool.name}`);
    }
  }

  const composeExecutor = await verifyDockerCompose();
  const manager = await detectPackageManager();
  await installDependencies(manager);
  const envCreated = await generateEnvFile();
  const services = await startDockerServices(composeExecutor);
  const migrationsExecuted = await runScriptIfPresent(manager, "migrate");
  const seedersExecuted = await runScriptIfPresent(manager, "seed");
  const healthChecks = await performHealthChecks();

  return {
    packageManager: manager,
    envGenerated: envCreated,
    dockerServices: services,
    migrationsExecuted,
    seedersExecuted,
    healthChecks
  };
}
