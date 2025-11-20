export interface RoleShortcut {
    name: string;
    command: string;
    description?: string;
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
    healthChecks: Array<{
        url: string;
        healthy: boolean;
        status?: number;
    }>;
}
type PackageManager = "pnpm" | "yarn" | "npm";
export declare function applyRoleSetup(role: string): Promise<RoleSetupResult>;
export declare function runLocalEnvironmentSetup(): Promise<LocalSetupResult>;
export {};
//# sourceMappingURL=setup.service.d.ts.map