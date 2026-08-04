import type { Project } from "../lib/projects";

export interface ProjectTabsProps {
  readonly projects: readonly Project[];
  readonly activeName: string | null;
  readonly onSelect: (name: string) => void;
  readonly onRemove: (name: string) => void;
  readonly onAdd: () => void;
}

/**
 * The top-level project strip (DESIGN.md §5): one tab per registered
 * repository.
 *
 * Removing a project is registry-only and the button says so, because "remove"
 * next to a repository name reads like deletion and this one never touches the
 * working tree.
 */
export function ProjectTabs({
  projects,
  activeName,
  onSelect,
  onRemove,
  onAdd,
}: ProjectTabsProps) {
  return (
    <nav className="projects" aria-label="Projects">
      <ul className="projects__list">
        {projects.map((project) => (
          <li
            key={project.name}
            className={`projects__tab${
              project.name === activeName ? " projects__tab--active" : ""
            }`}
          >
            <button
              type="button"
              className="projects__select"
              aria-current={project.name === activeName ? "page" : undefined}
              title={project.path}
              onClick={() => {
                onSelect(project.name);
              }}
            >
              {project.name}
            </button>
            <button
              type="button"
              className="projects__remove"
              aria-label={`Remove ${project.name} from the project list`}
              title="Remove from the list — the repository on disk is untouched"
              onClick={() => {
                onRemove(project.name);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <button type="button" className="projects__add" onClick={onAdd}>
        + Project
      </button>
    </nav>
  );
}
