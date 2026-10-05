import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, writable: true, value: testWindow.document },
    window: { configurable: true, writable: true, value: testWindow },
    navigator: { configurable: true, writable: true, value: testWindow.navigator },
    localStorage: { configurable: true, writable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

/** Mount real provider settings and capture submitted patches without persisting account configuration. */
async function mountSettings(item: WorkspaceItem, availableModels: string[] = []): Promise<{
  root: Root;
  container: HTMLElement;
  patches: ProviderUpdatePatch[];
}> {
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderSettings
          item={item}
          availableModels={availableModels}
          onUpdateProvider={async (_name, patch) => {
            patches.push(patch);
            return { ok: true };
          }}
        />
      </LanguageProvider>,
    );
  });
  return { root, container, patches };
}

/** Find the routing-mode control by its detection option without depending on translated labels. */
function selectionSelect(container: HTMLElement): HTMLSelectElement | null {
  return Array.from(container.querySelectorAll<HTMLSelectElement>("select.input"))
    .find(select => Array.from(select.options).some(option => option.value === "detect")) ?? null;
}

/** Set the native select value and emit a bubbling change event so React observes the chosen routing mode. */
async function choose(select: HTMLSelectElement, value: "detect" | "auto" | "manual"): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
}

/** Activate the settings save control and flush its submitted patch before inspecting preserved preferences. */
async function save(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary");
  expect(button).toBeTruthy();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
}


const copilot: WorkspaceItem = { name: "github-copilot", adapter: "openai-chat", baseUrl: "https://api.githubcopilot.com", authMode: "oauth", defaultModel: "gpt-4o" };

test("Copilot defaults to permission detection without manufacturing a config pin", async () => {
  const { root, container } = await mountSettings(copilot);
  expect(selectionSelect(container)?.value).toBe("detect");
  expect(container.textContent).toContain("Student / Free (Auto only)");
  expect(container.querySelector(".pwi-settings-sticky-bar")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("Copilot Auto save preserves manual default and switching back restores its control", async () => {
  const { root, container, patches } = await mountSettings(copilot);
  await choose(selectionSelect(container)!, "auto");
  expect(container.querySelector<HTMLInputElement>('input[value="auto"]')?.disabled).toBe(true);
  await save(container);
  expect(patches[0]).toMatchObject({ copilotModelSelection: "auto", defaultModel: "gpt-4o" });
  await choose(selectionSelect(container)!, "manual");
  await save(container);
  expect(patches[1]).toMatchObject({ copilotModelSelection: "manual", defaultModel: "gpt-4o" });
  await act(async () => { root.unmount(); });
});

test("the Copilot choice is absent for other providers", async () => {
  const { root, container } = await mountSettings({ ...copilot, name: "relay" });
  expect(selectionSelect(container)).toBeNull();
  await act(async () => { root.unmount(); });
});


test("permission detection hides a saved manual model when discovery exposes only Auto", async () => {
  const { root, container } = await mountSettings(copilot, ["auto"]);
  expect(selectionSelect(container)?.value).toBe("detect");
  expect(container.querySelector<HTMLInputElement>('input[value="auto"]')?.disabled).toBe(true);
  expect(container.querySelector(".pwi-settings-sticky-bar")).toBeNull();
  await act(async () => { root.unmount(); });
});
