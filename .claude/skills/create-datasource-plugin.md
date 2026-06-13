# Skill: Create Data Source Plugin

## When to Use
Use this skill when the user wants to create a new data source plugin for the Hypen framework. Data source plugins connect live subscription databases (SpacetimeDB, Firebase, Convex, Electric SQL, Supabase, etc.) to the Hypen reactive engine.

## Instructions

Create a new data source plugin package. The user will provide the database/service name. Follow these steps:

### 1. Scaffold the Package

Create the package at `hypen-plugin-{name}/` (or `packages/plugin-{name}/` if inside a monorepo) with this structure:

```
hypen-plugin-{name}/
├── src/
│   └── index.ts
├── package.json
├── tsconfig.json
└── README.md
```

### 2. Create package.json

```json
{
  "name": "@hypen-space/plugin-{name}",
  "version": "0.1.0",
  "description": "Hypen data source plugin for {Name}",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "peerDependencies": {
    "@hypen-space/core": ">=0.1.0"
  },
  "dependencies": {}
}
```

Add the database's client SDK to `dependencies` if the user specifies one.

### 3. Create tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

### 4. Create src/index.ts

The plugin must implement the `DataSourcePlugin<TConfig>` interface from `@hypen-space/core`. Use this template:

```typescript
import type {
  DataSourcePlugin,
  DataSourceStatus,
  DataSourceQuery,
  DataSourceSubscription,
  DataSourceChange,
} from "@hypen-space/core";

// ── Configuration ──────────────────────────────────────────────────
export interface {Name}Config {
  /** Connection URI (e.g., "ws://localhost:3000") */
  uri: string;
  /** Database or module name */
  moduleName: string;
  /** Tables/collections to subscribe to on connect */
  tables: string[];
}

// ── Plugin ─────────────────────────────────────────────────────────
export class {Name}Plugin implements DataSourcePlugin<{Name}Config> {
  readonly name = "{name}";
  status: DataSourceStatus = "disconnected";

  private onChange?: (change: DataSourceChange) => void;
  private config?: {Name}Config;
  // TODO: Add database client SDK instance field here

  async connect(
    config: {Name}Config,
    onChange: (change: DataSourceChange) => void
  ): Promise<void> {
    this.config = config;
    this.onChange = onChange;
    this.status = "connecting";

    try {
      // TODO: Initialize database client connection
      // Example:
      //   this.client = new {Name}Client(config.uri);
      //   await this.client.connect();

      // Subscribe to configured tables
      for (const table of config.tables) {
        this.subscribeToTable(table);
      }

      this.status = "connected";
    } catch (error) {
      this.status = "error";
      throw error;
    }
  }

  subscribe(query: DataSourceQuery): DataSourceSubscription {
    this.subscribeToTable(query.table);
    return {
      unsubscribe: () => {
        // TODO: Unsubscribe from the table/query
      },
      status: "applied",
    };
  }

  async call(method: string, ...args: unknown[]): Promise<unknown> {
    // TODO: Call a remote procedure / reducer / mutation
    // Example:
    //   return this.client.call(method, ...args);
    throw new Error(`call("${method}") not implemented`);
  }

  async disconnect(): Promise<void> {
    // TODO: Close the database connection and clean up
    // Example:
    //   await this.client.disconnect();
    this.status = "disconnected";
  }

  // ── Private ────────────────────────────────────────────────────

  private subscribeToTable(table: string): void {
    // TODO: Subscribe to a table and push updates via onChange
    //
    // When data changes, call:
    //   this.onChange?.({
    //     paths: [table],
    //     values: { [table]: rows },
    //   });
    //
    // The DataSourceManager accumulates sparse updates per-table,
    // so you only need to push the tables that changed.
  }
}
```

Replace `{Name}` with the PascalCase name and `{name}` with the lowercase name.

### 5. Key Implementation Notes

Tell the user these important points:

- **`name` property**: Must be unique across all plugins. This becomes the `@name.*` prefix in Hypen DSL bindings.
- **`onChange` callback**: Push data as `{ paths: [tableName], values: { [tableName]: rows } }`. The `DataSourceManager` merges sparse updates — you only need to push changed tables.
- **`status` tracking**: Update `status` at each stage. The host application can read `plugin.status` to show connection state in the UI.
- **`call()` method**: Exposes remote mutations to action handlers. Calls are proxied: `dataSources.{name}.myMethod(arg)` becomes `plugin.call("myMethod", arg)`.
- **Reconnection**: Handle reconnection logic inside the plugin. Update `status` to `"reconnecting"` during retries.

### 6. Show Usage Example

After creating the plugin, show the user how to use it:

```typescript
import { app, hypen, state } from "@hypen-space/core";
import { {Name}Plugin } from "@hypen-space/plugin-{name}";

export default app
  .defineState({ inputText: "" })
  .useDataSource(new {Name}Plugin(), {
    uri: "ws://localhost:3000",
    moduleName: "myapp",
    tables: ["items"],
  })
  .onAction("addItem", async ({ state, dataSources }) => {
    await dataSources.{name}.addItem(state.inputText);
    state.inputText = "";
  })
  .ui(hypen`
    Column {
      ForEach(items: @${name}.items, key: "id") {
        Text("@{item.name}")
      }
      Row {
        Input(placeholder: "New item...")
          .bind(@state.inputText)
        Button { Text("Add") }
          .onClick(@actions.addItem)
      }
    }
  `);
```

Note: In the DSL, `@` prefix is used for all references: data sources (e.g., `@spacetime.messages`), state (`@state.count`), actions (`@actions.submit`), and template interpolation (`@{state.count}`).
