import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { detachedBuild } from "./lib/build";
import { project as models } from "../wailsjs/go/models";
import type { Project, Registry } from "./lib/projects";
import type { Endpoint } from "./lib/stream";
import type { Git, Status } from "./lib/git";
import { MODIFIED, emptyStatus } from "./lib/git";

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
function project(name: string, path = `/w/${name}`, context = ""): Project {
  // createFrom rather than an object literal: the generated model is a class,
  // and a fixture that merely matched its fields would drift the moment the Go
  // struct gained one.
  return models.Project.createFrom({
    name,
    path,
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
    add: vi.fn((path: string) => {
      const added = project(path.split("/").pop() ?? "repo", path);
      state.projects = [...state.projects, added];
      return Promise.resolve(added);
    }),
    remove: vi.fn((name: string) => {
      state.projects = state.projects.filter((p) => p.name !== name);
      return Promise.resolve();
    }),
    update: vi.fn((name: string) =>
      Promise.resolve(project(name, `/w/${name}`)),
    ),
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
  // Choosing a checkout is a filesystem browse, so the button opens the OS
  // picker rather than asking the user to type a path they would have had to go
  // and find anyway.
  it("opens the directory picker and registers what was chosen", async () => {
    const { registry } = await renderWith([]);

    open("+ Project");

    await waitFor(() => {
      expect(registry.choose).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(registry.add).toHaveBeenCalledWith("/w/infra");
    });
    expect((await screen.findByTestId("project-status")).textContent).toContain(
      "infra",
    );
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

    open("+ Project");

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

    open("+ shell");
    open("+ shell");
    open("+ Claude Code");

    expect(screen.getByRole("tab", { name: /shell 1/ })).toBeDefined();
    expect(screen.getByRole("tab", { name: /shell 2/ })).toBeDefined();
    expect(screen.getByRole("tab", { name: /claude 1/ })).toBeDefined();
  });

  it("selects a newly opened tab", async () => {
    await renderWith(["infra"]);

    open("+ shell");
    open("+ shell");

    expect(
      screen.getByRole("tab", { name: /shell 2/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: /shell 1/ }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("moves the selection to a neighbour when the active tab closes", async () => {
    await renderWith(["infra"]);

    open("+ shell");
    open("+ shell");
    fireEvent.click(screen.getByRole("button", { name: "close shell 2" }));

    expect(screen.queryByRole("tab", { name: /shell 2/ })).toBeNull();
    expect(
      screen.getByRole("tab", { name: /shell 1/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("renames a tab in place", async () => {
    await renderWith(["infra"]);

    open("+ shell");
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

    open("+ shell");
    open("+ shell");
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

    open("+ shell");
    open("beta");
    open("+ shell");

    expect(screen.getByRole("tab", { name: /shell 1/ })).toBeDefined();
    expect(screen.queryByRole("tab", { name: /shell 2/ })).toBeNull();
  });

  // Switching projects must not disturb a running shell, and coming back must
  // land on the tab that was left selected rather than resetting.
  it("restores the selection when a project is revisited", async () => {
    await renderWith(["alpha", "beta"]);

    open("+ shell");
    open("+ shell");
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
  /** A Git seam answering per project root. */
  function fakeGit(byRoot: Record<string, Status>): Git {
    return { status: (root) => Promise.resolve(byRoot[root] ?? emptyStatus()) };
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
          git: {
            status: () => {
              throw new Error("no Wails runtime");
            },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("git-status").textContent).toBe("no Wails runtime");
    });
  });
});
