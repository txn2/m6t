import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { detachedBuild } from "./lib/build";
import { project as models, session as sessionModels, watch } from "../wailsjs/go/models";
import type { Directory } from "./lib/directory";
import type { Files } from "./lib/files";
import type { Project, Registry } from "./lib/projects";
import type { Endpoint } from "./lib/stream";
import type { Git, Status } from "./lib/git";
import { MODIFIED, NOT_A_REPOSITORY, UNTRACKED, emptyBlame, emptyStatus } from "./lib/git";

/**
 * A full `Git` seam from the one or two calls a test actually cares about.
 *
 * The mutations resolve with nothing rather than throwing: a test asserting on
 * the status line should not fail because a control it never touched has no
 * backend behind it.
 */
function stubGit(overrides: Partial<Git> = {}): Git {
  return {
    status: () => Promise.resolve(emptyStatus()),
    blame: () => Promise.resolve(emptyBlame()),
    pull: () => Promise.resolve(),
    push: () => Promise.resolve(),
    checkout: () => Promise.resolve(),
    branches: () => Promise.resolve([]),
    remotes: () => Promise.resolve([]),
    ...overrides,
  };
}

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The endpoint that never arrives.
 *
 * Every test here is about the shell around the terminals — the project strip,
 * the terminal strip, the status line — so the panes are deliberately kept from
 * mounting: a mounted pane builds a real xterm, which needs a canvas jsdom does
 * not have. The pane's own behaviour is covered in
 * components/TerminalPane.test.tsx.
 */
const pending = () => new Promise<Endpoint>(() => undefined);

const attached = () =>
  Promise.resolve({
    info: { version: "v1.2.0", commit: "a1b2c3d", date: "2026-08-02" },
    attached: true,
  });

/** A project in the shape the generated binding produces. */
function project(
  name: string,
  path = `/w/${name}`,
  context = "",
  rest: { displayName?: string; color?: string } = {},
): Project {
  // createFrom rather than an object literal: the generated model is a class,
  // and a fixture that merely matched its fields would drift the moment the Go
  // struct gained one.
  return models.Project.createFrom({
    name,
    path,
    displayName: rest.displayName ?? "",
    color: rest.color ?? "",
    kube: { context, namespace: "", protected: false },
    helm: { defaultValues: [] },
  });
}

/** A registry over an in-memory list, with every call spied on. */
function fakeRegistry(initial: Project[] = []): Registry & {
  projects: Project[];
} {
  const state = { projects: [...initial] };
  return {
    get projects() {
      return state.projects;
    },
    list: vi.fn(() => Promise.resolve([...state.projects])),
    // The picker: tests override this to stand in for what the user chose.
    choose: vi.fn(() => Promise.resolve("/w/infra")),
    add: vi.fn((path: string, name: string) => {
      const added = project(path.split("/").pop() ?? "repo", path, "", {
        displayName: name,
      });
      state.projects = [...state.projects, added];
      return Promise.resolve(added);
    }),
    remove: vi.fn((name: string) => {
      state.projects = state.projects.filter((p) => p.name !== name);
      return Promise.resolve();
    }),
    // The registry's Update replaces the mutable half whole, so the fake does
    // too: a test that renamed a project and got its old settings back would
    // hide exactly the bug `settingsFor` exists to prevent.
    update: vi.fn((name: string, settings: models.Settings) => {
      const updated = project(name, `/w/${name}`, settings.kube.context, {
        displayName: settings.displayName,
        color: settings.color,
      });
      state.projects = state.projects.map((p) =>
        p.name === name ? updated : p,
      );
      return Promise.resolve(updated);
    }),
    reorder: vi.fn((names: string[]) => {
      state.projects = names.map(
        (name) => state.projects.find((p) => p.name === name) as Project,
      );
      return Promise.resolve([...state.projects]);
    }),
  };
}

/** Renders the app over a registry already holding `names`. */
async function renderWith(names: string[], registry = fakeRegistry(names.map((n) => project(n)))) {
  const view = render(
    <App load={attached} endpoint={pending} backend={{ registry }} />,
  );
  if (names.length > 0) {
    await screen.findByRole("button", { name: names[0] });
  }
  return { ...view, registry };
}

const open = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: label }));
};

describe("the build identity in the status line", () => {
  it("reports what the backend says", async () => {
    render(
      <App load={attached} endpoint={pending} backend={{ registry: fakeRegistry() }} />,
    );

    expect((await screen.findByTestId("build-version")).textContent).toBe(
      "v1.2.0",
    );
    expect(screen.getByTestId("build-commit").textContent).toBe("a1b2c3d");
    expect(screen.getByTestId("build-date").textContent).toBe("2026-08-02");
    expect(screen.getByTestId("bridge-status").textContent).toBe(
      "connected to the Wails backend",
    );
  });

  it("says so when there is no Wails runtime to answer", async () => {
    render(
      <App
        load={() => Promise.resolve({ info: detachedBuild, attached: false })}
        endpoint={pending}
        backend={{ registry: fakeRegistry() }}
      />,
    );

    expect((await screen.findByTestId("bridge-status")).textContent).toBe(
      "detached — no Wails runtime",
    );
    expect(screen.getByTestId("build-version").textContent).toBe("dev");
  });
});

describe("the project strip", () => {
  it("shows a tab per registered project and opens the first one", async () => {
    await renderWith(["infra-prod", "infra-staging"]);

    expect(screen.getByRole("button", { name: "infra-prod" })).toBeDefined();
    expect(screen.getByRole("button", { name: "infra-staging" })).toBeDefined();
    expect(screen.getByTestId("project-status").textContent).toContain(
      "infra-prod",
    );
  });

  it("says there is nothing open when the registry is empty", async () => {
    render(
      <App load={attached} endpoint={pending} backend={{ registry: fakeRegistry() }} />,
    );

    expect(await screen.findByText(/No project open/)).toBeDefined();
  });

  it("switches the workbench when another project is selected", async () => {
    await renderWith(["infra-prod", "infra-staging"]);

    open("infra-staging");

    expect(screen.getByTestId("project-status").textContent).toContain(
      "infra-staging",
    );
  });

  // The binding is what enables every cluster action, so "not bound" has to be
  // legible rather than merely absent.
  it("reports an unbound kube context", async () => {
    const registry = fakeRegistry([project("infra", "/w/infra", "")]);
    await renderWith(["infra"], registry);

    expect(screen.getByTestId("project-status").textContent).toBe(
      "infra — no context bound",
    );
  });

  it("shows the bound context when there is one", async () => {
    const registry = fakeRegistry([
      project("infra", "/w/infra", "prod-us-west"),
    ]);
    await renderWith(["infra"], registry);

    expect(screen.getByTestId("project-status").textContent).toBe(
      "infra — prod-us-west",
    );
  });

  // A registry that will not load must say so. An empty strip would read as
  // "you have no projects" when the truth is a projects.yaml the user broke.
  it("surfaces a registry that fails to load", async () => {
    const registry = fakeRegistry();
    registry.list = vi.fn(() =>
      Promise.reject(new Error("parsing projects.yaml: line 3")),
    );

    render(<App load={attached} endpoint={pending} backend={{ registry }} />);

    expect(
      (await screen.findByRole("alert")).textContent,
    ).toContain("parsing projects.yaml");
  });
});

describe("adding a project", () => {
  /** Runs the add flow to the point where the name field is on screen. */
  async function nameField() {
    open("+ Project");
    return await screen.findByRole("textbox", { name: "project name" });
  }

  // Choosing a checkout is a filesystem browse, so the button opens the OS
  // picker rather than asking the user to type a path they would have had to go
  // and find anyway.
  it("opens the directory picker and registers what was chosen", async () => {
    const { registry } = await renderWith([]);

    const field = await nameField();
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => {
      expect(registry.add).toHaveBeenCalledWith("/w/infra", "infra");
    });
    expect((await screen.findByTestId("project-status")).textContent).toContain(
      "infra",
    );
  });

  // The acceptance criterion: almost every manifest repository is checked out
  // as "k8s", so the directory name is a prefilled suggestion rather than the
  // identity the user is stuck with (#41).
  it("prefills the directory name and registers the one typed instead", async () => {
    const registry = fakeRegistry();
    registry.choose = vi.fn(() => Promise.resolve("/w/ops/k8s"));
    render(<App load={attached} endpoint={pending} backend={{ registry }} />);

    const field = await nameField();
    expect((field as HTMLInputElement).value).toBe("k8s");
    fireEvent.change(field, { target: { value: "Production infra" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => {
      expect(registry.add).toHaveBeenCalledWith("/w/ops/k8s", "Production infra");
    });
    expect(
      await screen.findByRole("button", { name: "Production infra" }),
    ).toBeDefined();
  });

  // Escape abandons the naming, and the abandoned pick must not be registered
  // behind it — the field is removed from a focused state and its blur would
  // otherwise commit what the user just backed out of.
  it("registers nothing when the naming is abandoned", async () => {
    const { registry } = await renderWith([]);

    const field = await nameField();
    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.blur(field);

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "project name" })).toBeNull();
    });
    expect(registry.add).not.toHaveBeenCalled();
  });

  // Dismissing the dialog is an ordinary outcome, not a failure. Registering
  // "" would ask the backend to add the process working directory, and showing
  // an error would put a red box on screen for a decision the user made.
  it("does nothing when the picker is cancelled", async () => {
    const registry = fakeRegistry();
    registry.choose = vi.fn(() => Promise.resolve(""));
    render(<App load={attached} endpoint={pending} backend={{ registry }} />);

    open("+ Project");

    await waitFor(() => {
      expect(registry.choose).toHaveBeenCalled();
    });
    expect(registry.add).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await screen.findByText(/No project open/)).toBeDefined();
  });

  it("says why when the chosen directory is not a repository", async () => {
    const registry = fakeRegistry();
    registry.choose = vi.fn(() => Promise.resolve("/w/plain"));
    registry.add = vi.fn(() =>
      Promise.reject(new Error("not a git repository")),
    );
    render(<App load={attached} endpoint={pending} backend={{ registry }} />);

    fireEvent.keyDown(await nameField(), { key: "Enter" });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "not a git repository",
    );
  });

  it("surfaces a picker that cannot open", async () => {
    const registry = fakeRegistry();
    registry.choose = vi.fn(() =>
      Promise.reject(new Error("the application window is not ready")),
    );
    render(<App load={attached} endpoint={pending} backend={{ registry }} />);

    open("+ Project");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "window is not ready",
    );
  });
});

describe("project tab identity (#41)", () => {
  /** Opens a tab's context menu and returns the menu element. */
  async function menuFor(label: string) {
    fireEvent.contextMenu(screen.getByRole("button", { name: label }));
    return await screen.findByRole("menu", { name: `${label} actions` });
  }

  it("shows the label rather than the registry key, with the path as the tooltip", async () => {
    const registry = fakeRegistry([
      project("k8s", "/w/ops/k8s", "", { displayName: "Production infra" }),
    ]);
    render(<App load={attached} endpoint={pending} backend={{ registry }} />);

    const tab = await screen.findByRole("button", { name: "Production infra" });
    expect(tab.getAttribute("title")).toBe("/w/ops/k8s");
    expect(screen.getByTestId("project-status").textContent).toContain(
      "Production infra",
    );
  });

  it("falls back to the registry name when a project has no label", async () => {
    await renderWith(["infra"]);

    expect(screen.getByRole("button", { name: "infra" })).toBeDefined();
  });

  // The whole point of DisplayName being a setting rather than the key: the
  // rename must not disturb the binding that decides what an apply applies to.
  it("renames from the tab menu and keeps the kube binding", async () => {
    const registry = fakeRegistry([project("k8s", "/w/k8s", "prod-us-west")]);
    render(<App load={attached} endpoint={pending} backend={{ registry }} />);
    await screen.findByRole("button", { name: "k8s" });

    await menuFor("k8s");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    // The menu goes with the click that started the rename, and the field
    // arrives once it has: mounting the field under an open menu put it inside
    // the inert region, where it took focus and lost it again — committing a
    // rename the user had not typed.
    const field = await screen.findByRole("textbox", { name: "rename k8s" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.change(field, { target: { value: "Production" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => {
      expect(registry.update).toHaveBeenCalledWith(
        "k8s",
        expect.objectContaining({
          displayName: "Production",
          kube: expect.objectContaining({ context: "prod-us-west" }),
        }),
      );
    });
    expect(
      await screen.findByRole("button", { name: "Production" }),
    ).toBeDefined();
    expect(screen.getByTestId("project-status").textContent).toBe(
      "Production — prod-us-west",
    );
  });

  // The colour is a dot beside the name, not the tab's edge rule: the edge
  // says which project is open, and a colour that took it over left that
  // question unanswered.
  it("sets a tab colour from the menu and marks it beside the name", async () => {
    const { registry, container } = await renderWith(["infra"]);

    await menuFor("infra");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "amber" }));

    await waitFor(() => {
      expect(registry.update).toHaveBeenCalledWith(
        "infra",
        expect.objectContaining({ color: "amber" }),
      );
    });
    await waitFor(() => {
      expect(
        container.querySelector(".projects__dot")?.getAttribute("data-color"),
      ).toBe("amber");
    });
    // Picking a colour is the end of the interaction; leaving the menu open
    // over the tab hides the mark the user just chose.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // A colour this build has no palette entry for — a projects.yaml someone
  // edited by hand — must render as no colour rather than reaching the DOM.
  it("ignores a stored colour it has no palette entry for", async () => {
    const registry = fakeRegistry([
      project("infra", "/w/infra", "", { color: "chartreuse" }),
    ]);
    const { container } = render(
      <App load={attached} endpoint={pending} backend={{ registry }} />,
    );
    await screen.findByRole("button", { name: "infra" });

    expect(container.querySelector(".projects__dot")).toBeNull();
  });

  // Reordering is dnd-kit's: the pointer sensor, the distance threshold, the
  // transforms and the keyboard path are its code and its test suite. What
  // this repo owns is that every tab is registered as a sortable item — the
  // wiring that, if it were wrong, would leave a strip that simply does not
  // drag while every unit test still passed. `orderAfterDrag` covers the other
  // half, in lib/projects.test.ts.
  it("registers every tab as a sortable item", async () => {
    await renderWith(["alpha", "beta"]);

    for (const name of ["alpha", "beta"]) {
      const tab = screen.getByRole("button", { name });
      expect(tab.getAttribute("aria-roledescription")).toBe("project tab");
      // dnd-kit points this at its own keyboard instructions; without it the
      // tab is not attached to a DndContext at all.
      expect(tab.getAttribute("aria-describedby")).toBeTruthy();
    }
  });

  // Selecting a project must survive the drag sensor sitting on the same
  // button: a click that never moved is a click.
  it("still selects a project on a plain click", async () => {
    await renderWith(["alpha", "beta"]);

    open("beta");

    expect(screen.getByTestId("project-status").textContent).toContain("beta");
  });
});

describe("removing a project", () => {
  it("drops the tab and moves to a neighbour", async () => {
    const { registry } = await renderWith(["alpha", "beta"]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove alpha from the project list",
      }),
    );

    await waitFor(() => {
      expect(registry.remove).toHaveBeenCalledWith("alpha");
    });
    expect(screen.queryByRole("button", { name: "alpha" })).toBeNull();
    expect(screen.getByTestId("project-status").textContent).toContain("beta");
  });
});

describe("the stream endpoint", () => {
  it("says it is still connecting before the endpoint arrives", async () => {
    await renderWith(["infra"]);

    expect(screen.getByTestId("stream-status").textContent).toContain(
      "connecting",
    );
  });

  // StreamEndpoint fails until the listener is up and its error says why. A UI
  // that showed an empty pane instead would be indistinguishable from a
  // backend that started but produced nothing.
  it("shows why the terminal backend is unreachable", async () => {
    render(
      <App
        load={attached}
        endpoint={() => Promise.reject(new Error("stream server is not started"))}
        backend={{ registry: fakeRegistry([project("infra")]) }}
      />,
    );

    expect((await screen.findByTestId("stream-status")).textContent).toBe(
      "stream server is not started",
    );
  });

  // The binding throws rather than rejecting when there is no runtime behind
  // it, which would otherwise take the whole render down.
  it("survives a binding that throws instead of rejecting", async () => {
    render(
      <App
        load={attached}
        endpoint={() => {
          throw new TypeError("window.go is undefined");
        }}
        backend={{ registry: fakeRegistry([project("infra")]) }}
      />,
    );

    expect((await screen.findByTestId("stream-status")).textContent).toBe(
      "window.go is undefined",
    );
  });
});

describe("opening and closing terminal tabs", () => {
  it("numbers each kind of tab separately", async () => {
    await renderWith(["infra"]);

    open("new shell");
    open("new shell");
    open("new Claude Code session");

    expect(screen.getByRole("tab", { name: /shell 1/ })).toBeDefined();
    expect(screen.getByRole("tab", { name: /shell 2/ })).toBeDefined();
    expect(screen.getByRole("tab", { name: /claude 1/ })).toBeDefined();
  });

  it("selects a newly opened tab", async () => {
    await renderWith(["infra"]);

    open("new shell");
    open("new shell");

    expect(
      screen.getByRole("tab", { name: /shell 2/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: /shell 1/ }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("moves the selection to a neighbour when the active tab closes", async () => {
    await renderWith(["infra"]);

    open("new shell");
    open("new shell");
    fireEvent.click(screen.getByRole("button", { name: "close shell 2" }));

    expect(screen.queryByRole("tab", { name: /shell 2/ })).toBeNull();
    expect(
      screen.getByRole("tab", { name: /shell 1/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("renames a tab in place", async () => {
    await renderWith(["infra"]);

    open("new shell");
    fireEvent.doubleClick(screen.getByRole("tab", { name: /shell 1/ }));
    const field = screen.getByRole("textbox", { name: "rename shell 1" });
    fireEvent.change(field, { target: { value: "cluster logs" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(screen.getByRole("tab", { name: /cluster logs/ })).toBeDefined();
  });
});

describe("terminals scoped to a project", () => {
  // The acceptance criterion: a tab opened in one project must not appear in
  // another, and each project's numbering starts from one.
  it("shows only the active project's tabs", async () => {
    await renderWith(["alpha", "beta"]);

    open("new shell");
    open("new shell");
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    open("beta");

    expect(screen.queryAllByRole("tab")).toHaveLength(0);

    // The two tabs still exist — they belong to alpha, and returning shows
    // them again. A strip that had actually dropped them would fail here.
    open("alpha");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("numbers each project's tabs from one", async () => {
    await renderWith(["alpha", "beta"]);

    open("new shell");
    open("beta");
    open("new shell");

    expect(screen.getByRole("tab", { name: /shell 1/ })).toBeDefined();
    expect(screen.queryByRole("tab", { name: /shell 2/ })).toBeNull();
  });

  // Switching projects must not disturb a running shell, and coming back must
  // land on the tab that was left selected rather than resetting.
  it("restores the selection when a project is revisited", async () => {
    await renderWith(["alpha", "beta"]);

    open("new shell");
    open("new shell");
    fireEvent.click(screen.getByRole("tab", { name: /shell 1/ }));
    open("beta");
    open("alpha");

    expect(
      screen.getByRole("tab", { name: /shell 1/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("appearance (#33)", () => {
  /** Installs a matchMedia the app will read, and returns a way to flip it. */
  function stubOSAppearance(light: boolean) {
    const listeners: (() => void)[] = [];
    const query = {
      matches: light,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.push(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        const at = listeners.indexOf(listener);
        if (at >= 0) {
          listeners.splice(at, 1);
        }
      },
    };
    vi.stubGlobal("matchMedia", () => query);
    return (to: boolean) => {
      query.matches = to;
      act(() => {
        for (const listener of [...listeners]) {
          listener();
        }
      });
    };
  }

  // The theme toggle is gone: theme configuration belongs in a settings
  // dialog, and until there is one the OS is the only source of truth.
  it("has no theme control in the chrome", async () => {
    await renderWith(["infra"]);

    expect(screen.queryByRole("button", { name: /theme/ })).toBeNull();
  });

  it("starts in the appearance the OS asks for", async () => {
    stubOSAppearance(true);

    const { container } = await renderWith(["infra"]);

    expect(container.querySelector(".shell")?.className).toContain("shell--light");
  });

  // Removing the button is only a fix if the app tracks the OS while running.
  // Without this it would sit in yesterday's theme until restarted.
  it("follows the OS when the appearance changes while running", async () => {
    const flip = stubOSAppearance(false);
    const { container } = await renderWith(["infra"]);
    expect(container.querySelector(".shell")?.className).toContain("shell--dark");

    flip(true);

    expect(container.querySelector(".shell")?.className).toContain("shell--light");
  });

  // Below the minimum the box-drawing characters a TUI is built from stop
  // resolving, so the field's value is held inside the usable range.
  it("holds the font size inside the usable range", async () => {
    await renderWith(["infra"]);
    const field = screen.getByRole("spinbutton");

    fireEvent.change(field, { target: { value: "400" } });

    expect((field as HTMLInputElement).value).toBe("22");
  });
});

describe("the git line in the status bar (#8)", () => {
  /** A Git seam answering per project root. The mutations are inert: these
   * tests exercise the status line, and #9's operations have their own. */
  function fakeGit(byRoot: Record<string, Status>): Git {
    return stubGit({ status: (root) => Promise.resolve(byRoot[root] ?? emptyStatus()) });
  }

  function changedOn(branch: string, paths: string[]): Status {
    const empty = emptyStatus();
    return {
      ...empty,
      branch: { ...empty.branch, name: branch, upstream: `origin/${branch}`, ahead: 1, behind: 0 },
      files: paths.map((path) => ({
        path,
        staged: "",
        worktree: MODIFIED,
        conflicted: false,
        origPath: "",
      })),
    };
  }

  it("reports the active project's branch and change count", async () => {
    const registry = fakeRegistry([project("infra", "/w/infra")]);
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{ registry, git: fakeGit({ "/w/infra": changedOn("main", ["a.yaml", "b.yaml"]) }) }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("git-status").textContent).toBe(
        "\u2387 main \u21911 \u21930 \u00b7 2 changed",
      );
    });
  });

  // The status bar follows the tab strip: a project switch must not leave the
  // previous repository's branch on screen.
  it("follows the selected project", async () => {
    const registry = fakeRegistry([
      project("infra", "/w/infra"),
      project("apps", "/w/apps"),
    ]);
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{
          registry,
          git: fakeGit({
            "/w/infra": changedOn("main", ["a.yaml"]),
            "/w/apps": changedOn("release", []),
          }),
        }}
      />,
    );
    await screen.findByRole("button", { name: "infra" });
    await waitFor(() => {
      expect(screen.getByTestId("git-status").textContent).toContain("main");
    });

    open("apps");

    await waitFor(() => {
      expect(screen.getByTestId("git-status").textContent).toBe(
        "\u2387 release \u21911 \u21930 \u00b7 no changes",
      );
    });
  });

  // The default seam is the generated binding, which throws when there is no
  // Wails runtime. The bar has to say so rather than take the render down.
  it("shows a failing binding as a message rather than crashing", async () => {
    const registry = fakeRegistry([project("infra", "/w/infra")]);
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{
          registry,
          git: stubGit({
            status: () => {
              throw new Error("no Wails runtime");
            },
          }),
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("git-status").textContent).toBe("no Wails runtime");
    });
  });
});

describe("the git operations (#9)", () => {
  /** A repository whose status changes when the seam is written to, so the
   * refresh-after-an-operation contract is observable rather than asserted on
   * a call count. */
  function pullingGit() {
    let pulled = false;
    const empty = emptyStatus();
    const branch = { ...empty.branch, name: "main", upstream: "origin/main" };
    const status = () =>
      Promise.resolve({
        ...empty,
        branch,
        files: pulled
          ? []
          : [
              {
                path: "a.yaml",
                staged: "",
                worktree: MODIFIED,
                conflicted: false,
                origPath: "",
              },
            ],
      });
    const pull = vi.fn(() => {
      pulled = true;
      return Promise.resolve();
    });
    return { seam: stubGit({ status, pull, branches: () => Promise.resolve(["main"]) }), pull };
  }

  // The composition test: the branch bar's button, the ops hook, the seam, and
  // the status re-read that makes the row go away. Each of those has its own
  // unit test; this is the only thing that fails when they are wired to each
  // other wrongly.
  it("pulls from the branch bar and shows the result", async () => {
    const { seam, pull } = pullingGit();
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{ registry: fakeRegistry([project("infra", "/w/infra")]), git: seam }}
      />,
    );

    // The button renders disabled first — the initial status has no upstream —
    // and only becomes usable once the real one lands.
    const button = await screen.findByRole("button", { name: "Pull" });
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByTestId("git-status").textContent).toContain("1 changed");

    fireEvent.click(button);

    await waitFor(() => {
      expect(pull).toHaveBeenCalledWith("/w/infra");
    });
    // The change went away, which only happens if the operation triggered a
    // re-read of the status.
    await waitFor(() => {
      expect(screen.getByTestId("git-status").textContent).toContain("no changes");
    });
  });

  // The commit box and the stage/unstage controls are gone (#39): what records
  // work is the agent in the terminal, and this is the assertion that fails if
  // one of them comes back through a component the workbench still renders.
  it("offers no control anywhere that writes the index", async () => {
    const { seam } = pullingGit();
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{ registry: fakeRegistry([project("infra", "/w/infra")]), git: seam }}
      />,
    );

    // A change on screen, so the sidebar is rendering a repository with work
    // in it rather than being absent for some unrelated reason.
    await waitFor(() => {
      expect(screen.getByTestId("git-status").textContent).toContain("1 changed");
    });

    for (const name of ["Stage a.yaml", "Unstage a.yaml", "Stage all", "Unstage all", "Commit"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByLabelText("Commit subject")).toBeNull();
    expect(screen.queryByLabelText("Commit body")).toBeNull();
  });

  // The changes panel is gone and its two degraded states went to the status
  // bar with it (#40). This is the composition assertion for that move: the
  // sidebar renders the tree and the branch bar, and nothing that used to say
  // "Changes" above a second list of the same paths.
  it("keeps the sidebar to the tree and the branch bar", async () => {
    const { seam } = pullingGit();
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{ registry: fakeRegistry([project("infra", "/w/infra")]), git: seam }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("git-status").textContent).toContain("1 changed");
    });

    expect(screen.queryByRole("region", { name: "Changes" })).toBeNull();
    expect(screen.getByRole("tree")).toBeDefined();
    expect(screen.getByRole("button", { name: "Pull" })).toBeDefined();
  });

  it("reports a repository git cannot read in the status bar", async () => {
    const seam = stubGit({
      status: () => Promise.resolve({ ...emptyStatus(), availability: NOT_A_REPOSITORY }),
    });
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{ registry: fakeRegistry([project("infra", "/w/infra")]), git: seam }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("git-status").textContent).toBe("not a git repository");
    });
  });

  // A failed operation reaches the user with git's own words in it — the whole
  // path from the binding's rejection to the alert on screen (DESIGN.md §7).
  it("shows a failed operation's stderr verbatim", async () => {
    const seam = stubGit({
      status: () =>
        Promise.resolve({
          ...emptyStatus(),
          branch: { ...emptyStatus().branch, name: "main", upstream: "origin/main" },
        }),
      branches: () => Promise.resolve(["main"]),
      pull: () =>
        Promise.reject(
          new Error("git pull in /w/infra: error: Your local changes would be overwritten"),
        ),
    });
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{ registry: fakeRegistry([project("infra", "/w/infra")]), git: seam }}
      />,
    );

    // The button renders disabled first — the initial status has no upstream
    // — and only becomes usable once the real one lands. Clicking the disabled
    // render would assert nothing at all.
    const pull = await screen.findByRole("button", { name: "Pull" });
    await waitFor(() => {
      expect((pull as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(pull);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "error: Your local changes would be overwritten",
      );
    });
  });
});

describe("the breadcrumb above the editor (#43)", () => {
  /** A project with one file three levels down, listed on demand. */
  const listings: Record<string, { name: string; isDir: boolean }[]> = {
    "": [{ name: "manifests", isDir: true }],
    manifests: [{ name: "prod", isDir: true }],
    "manifests/prod": [{ name: "ingress.yaml", isDir: false }],
  };

  function stubDirectory(): Directory {
    return {
      list: (_root, relPath) => Promise.resolve(listings[relPath] ?? []),
      create: () => Promise.resolve(),
      rename: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      prefixes: () => Promise.resolve({}),
    };
  }

  function stubFiles(): Files {
    return {
      read: () =>
        Promise.resolve(
          watch.FileContent.createFrom({
            content: "kind: Ingress\n",
            crlf: false,
            mixedEol: false,
            readOnly: false,
            size: 14,
          }),
        ),
      write: () => Promise.resolve(),
    };
  }

  /** Opens `manifests/prod/ingress.yaml` from the tree, the only way in. */
  async function openTheFile() {
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{
          registry: fakeRegistry([project("infra", "/w/infra")]),
          directory: stubDirectory(),
          files: stubFiles(),
          git: stubGit(),
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: /manifests/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /prod$/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /ingress\.yaml/ }));
    return screen.findByRole("navigation", { name: "path of ingress.yaml" });
  }

  /** The breadcrumb's segments, in order. */
  function segments(bar: HTMLElement): string[] {
    return [...bar.querySelectorAll("button, .breadcrumb__leaf")].map(
      (el) => el.textContent ?? "",
    );
  }

  it("shows the open file's path from the project root", async () => {
    const bar = await openTheFile();

    expect(segments(bar)).toEqual(["manifests", "prod", "ingress.yaml"]);
  });

  it("re-opens a directory in the tree when its segment is clicked", async () => {
    const bar = await openTheFile();
    // Collapse the whole chain, so the click has something to undo.
    fireEvent.click(screen.getByRole("treeitem", { name: /manifests/ }));
    expect(screen.queryByRole("treeitem", { name: /prod$/ })).toBeNull();

    fireEvent.click(within(bar).getByRole("button", { name: "prod" }));

    expect(screen.getByRole("treeitem", { name: /prod$/ })).toBeDefined();
    expect(
      screen.getByRole("treeitem", { name: /ingress\.yaml/ }).getAttribute("aria-selected"),
    ).toBe("false");
    // The directory the segment named is the one the tree now points at.
    expect(
      screen.getByRole("treeitem", { name: /prod$/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  // Changed-only mode is a filter over the rows, and a directory with nothing
  // changed under it has no row in that list to reveal.
  it("leaves changed-only mode to show a directory it was filtering out", async () => {
    const bar = await openTheFile();
    fireEvent.click(screen.getByRole("button", { name: "Changed only" }));
    expect(screen.getByText("Nothing has changed in this project.")).toBeDefined();

    fireEvent.click(within(bar).getByRole("button", { name: "manifests" }));

    expect(screen.getByRole("button", { name: "Changed only" })).toBeDefined();
    expect(screen.getByRole("treeitem", { name: /manifests/ })).toBeDefined();
  });

  it("says nothing when no file is open", async () => {
    await renderWith(["infra"]);

    // By name, because the project strip is a landmark of its own.
    expect(screen.queryByRole("navigation", { name: /^path of/ })).toBeNull();
  });
});

describe("the blame column above the editor (#52)", () => {
  const blame = {
    commits: [
      {
        sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        author: "Craig Johnston",
        authorTime: Math.floor(new Date(2026, 7, 6, 9, 30).getTime() / 1000),
        summary: "Add the ingress",
        uncommitted: false,
      },
      {
        sha: "0000000000000000000000000000000000000000",
        author: "Not Committed Yet",
        authorTime: 0,
        summary: "",
        uncommitted: true,
      },
    ],
    lines: [0, 1],
  };

  function stubDirectory(): Directory {
    return {
      list: (_root, relPath) =>
        Promise.resolve(relPath === "" ? [{ name: "ingress.yaml", isDir: false }] : []),
      create: () => Promise.resolve(),
      rename: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      prefixes: () => Promise.resolve({}),
    };
  }

  function stubFiles(): Files {
    return {
      read: () =>
        Promise.resolve(
          watch.FileContent.createFrom({
            content: "kind: Ingress\nname: web\n",
            crlf: false,
            mixedEol: false,
            readOnly: false,
            size: 24,
          }),
        ),
      write: () => Promise.resolve(),
    };
  }

  /** Opens the one file, with git answering `status` and `blame` as told. */
  async function openTheFile(git = stubGit({ blame: () => Promise.resolve(blame) })) {
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{
          registry: fakeRegistry([project("infra", "/w/infra")]),
          directory: stubDirectory(),
          files: stubFiles(),
          git,
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: /ingress\.yaml/ }));
    await screen.findByRole("navigation", { name: "path of ingress.yaml" });
  }

  /** The rendered entries of the blame column, in line order. */
  function entries(): string[] {
    return [...document.querySelectorAll(".cm-blame-entry")].map((el) => el.textContent ?? "");
  }

  it("attributes each line once the column is turned on", async () => {
    await openTheFile();

    fireEvent.click(screen.getByRole("button", { name: "Blame" }));

    await waitFor(() => {
      expect(entries()).toEqual(["CJ 2026-08-06", "uncommitted"]);
    });
  });

  it("does not read a blame for a file nobody asked about", async () => {
    const git = stubGit({ blame: vi.fn(() => Promise.resolve(blame)) });
    await openTheFile(git);

    expect(git.blame).not.toHaveBeenCalled();
  });

  it("takes the column away again", async () => {
    await openTheFile();
    fireEvent.click(screen.getByRole("button", { name: "Blame" }));
    await waitFor(() => {
      expect(entries()).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Blame" }));

    expect(document.querySelector(".cm-blame")).toBeNull();
  });

  it("offers nothing to blame for an untracked file", async () => {
    await openTheFile(
      stubGit({
        status: () =>
          Promise.resolve({
            ...emptyStatus(),
            files: [
              {
                path: "ingress.yaml",
                staged: "",
                worktree: UNTRACKED,
                conflicted: false,
                origPath: "",
              },
            ],
          }),
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Blame" })).toBeNull();
    });
  });

  it("reports git's refusal in git's own words", async () => {
    await openTheFile(
      stubGit({
        blame: () => Promise.reject(new Error("fatal: no such path in HEAD")),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Blame" }));

    expect((await screen.findByRole("alert")).textContent).toContain("no such path in HEAD");
  });
});

describe("locating the open file in the tree (#56)", () => {
  const listings: Record<string, { name: string; isDir: boolean }[]> = {
    "": [{ name: "manifests", isDir: true }],
    manifests: [{ name: "prod", isDir: true }],
    "manifests/prod": [{ name: "ingress.yaml", isDir: false }],
  };

  function stubDirectory(): Directory {
    return {
      list: (_root, relPath) => Promise.resolve(listings[relPath] ?? []),
      create: () => Promise.resolve(),
      rename: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      prefixes: () => Promise.resolve({}),
    };
  }

  function stubFiles(): Files {
    return {
      read: () =>
        Promise.resolve(
          watch.FileContent.createFrom({
            content: "kind: Ingress\n",
            crlf: false,
            mixedEol: false,
            readOnly: false,
            size: 14,
          }),
        ),
      write: () => Promise.resolve(),
    };
  }

  /** Opens the nested file, then collapses the chain so nothing shows it. */
  async function openThenHide() {
    render(
      <App
        load={attached}
        endpoint={pending}
        backend={{
          registry: fakeRegistry([project("infra", "/w/infra")]),
          directory: stubDirectory(),
          files: stubFiles(),
          git: stubGit(),
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: /manifests/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /prod$/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /ingress\.yaml/ }));
    await screen.findByRole("navigation", { name: "path of ingress.yaml" });

    fireEvent.click(screen.getByRole("treeitem", { name: /manifests/ }));
    expect(screen.queryByRole("treeitem", { name: /ingress\.yaml/ })).toBeNull();
  }

  it("brings the open file back on screen and selects it", async () => {
    await openThenHide();

    fireEvent.click(screen.getByRole("button", { name: "Locate" }));

    const row = await screen.findByRole("treeitem", { name: /ingress\.yaml/ });
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  // Changed-only mode is a filter over the rows, and a file with nothing
  // changed has no row in that list to select.
  it("leaves changed-only mode, which would otherwise have no row to select", async () => {
    await openThenHide();
    fireEvent.click(screen.getByRole("button", { name: "Changed only" }));
    expect(screen.getByText("Nothing has changed in this project.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Locate" }));

    expect(await screen.findByRole("treeitem", { name: /ingress\.yaml/ })).toBeDefined();
  });

  it("says nothing when no file is open", async () => {
    await renderWith(["infra"]);

    expect(screen.queryByRole("button", { name: "Locate" })).toBeNull();
  });
});

/**
 * The session seam, wired through `App` rather than through the hook.
 *
 * `lib/useSession.test.ts` covers what restoring does; what is left to prove
 * here is that the composition root actually hands the store to it, and hands
 * the restored pane sizes to the workbench. Both are one line in `App` and
 * both fail silently — the app simply comes back at its defaults.
 */
describe("the saved session (#58)", () => {
  it("opens the project the session recorded rather than the first one", async () => {
    const registry = fakeRegistry([project("infra"), project("apps")]);
    const store = {
      load: () =>
        Promise.resolve(
          sessionModels.State.createFrom({ version: 1, activeProject: "apps", projects: [] }),
        ),
      save: vi.fn(() => Promise.resolve()),
    };

    render(<App load={attached} endpoint={pending} backend={{ registry, session: store }} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "apps" }).getAttribute("aria-current"),
      ).toBe("page");
    });
  });

  it("draws the workbench at the pane sizes the session recorded", async () => {
    const registry = fakeRegistry([project("infra")]);
    const store = {
      load: () =>
        Promise.resolve(
          sessionModels.State.createFrom({
            version: 1,
            activeProject: "infra",
            sidebar: 342,
            terminalHeight: 208,
            projects: [],
          }),
        ),
      save: vi.fn(() => Promise.resolve()),
    };

    const { container } = render(
      <App load={attached} endpoint={pending} backend={{ registry, session: store }} />,
    );

    await waitFor(() => {
      const workbench = container.querySelector(".workbench");
      expect(workbench?.getAttribute("style")).toContain("342px");
      expect(workbench?.getAttribute("style")).toContain("208px");
    });
  });
});
