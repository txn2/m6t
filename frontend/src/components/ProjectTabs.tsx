import { useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import type { Project } from "../lib/projects";
import { orderAfterDrag } from "../lib/projects";
import type { PendingProject } from "../lib/useProjects";
import { NameField, ProjectTab } from "./ProjectTab";

export interface ProjectTabsProps {
  readonly projects: readonly Project[];
  readonly activeName: string | null;
  /** A checkout chosen in the picker and waiting to be named (#41). */
  readonly pending: PendingProject | null;
  onSelect: (name: string) => void;
  onRename: (name: string, label: string) => void;
  onColor: (name: string, color: string) => void;
  /** The strip's new order, once a drag settles. */
  onMove: (names: string[]) => void;
  onRemove: (name: string) => void;
  onAdd: () => void;
  onAddCommit: (name: string) => void;
  onAddCancel: () => void;
}

/**
 * The top-level project strip (DESIGN.md §5): one tab per registered
 * repository, in the order the user arranged them.
 *
 * Reordering is dnd-kit's, not this file's. What it brings that a hand-written
 * drag does not: a distance threshold so a click stays a click, transforms and
 * transitions that move the displaced tabs instead of relaying the strip out,
 * keyboard reordering, touch, and a live region that announces the move. All
 * this component does is name the sensors and turn the drag's result into an
 * order.
 *
 * Space lifts the focused tab and the arrow keys move it; Enter is left alone
 * so it still opens the project.
 */
export function ProjectTabs({
  projects,
  activeName,
  pending,
  onSelect,
  onRename,
  onColor,
  onMove,
  onRemove,
  onAdd,
  onAddCommit,
  onAddCancel,
}: ProjectTabsProps) {
  const [editing, setEditing] = useState<string | null>(null);

  const sensors = useSensors(
    // Without a threshold every click on a tab is a one-pixel drag, and the
    // strip would write projects.yaml each time a project was selected.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Space alone lifts and drops. The default also binds Enter, which a
      // button already spends on its click — a keyboard user opening a project
      // would have picked it up instead.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const names = projects.map((project) => project.name);

  const settle = (event: DragEndEvent) => {
    const ordered = orderAfterDrag(names, event.active.id, event.over?.id);
    if (ordered !== null) {
      onMove(ordered);
    }
  };

  return (
    <nav className="projects" aria-label="Projects">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        // A tab strip is one row: a tab that could be lifted out of it, or
        // dragged past its ends, is a tab the drop can lose.
        modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
        onDragEnd={settle}
      >
        <SortableContext items={names} strategy={horizontalListSortingStrategy}>
          <ul className="projects__list">
            {projects.map((project) => (
              <ProjectTab
                key={project.name}
                project={project}
                active={project.name === activeName}
                editing={editing === project.name}
                onSelect={onSelect}
                onEdit={setEditing}
                onRename={onRename}
                onColor={onColor}
                onRemove={onRemove}
              />
            ))}
            {pending !== null && (
              <li className="projects__tab projects__tab--pending">
                <NameField
                  initial={pending.suggested}
                  ariaLabel="project name"
                  className="projects__rename"
                  onCommit={onAddCommit}
                  onCancel={onAddCancel}
                />
              </li>
            )}
          </ul>
        </SortableContext>
      </DndContext>

      <button type="button" className="projects__add" onClick={onAdd}>
        + Project
      </button>
    </nav>
  );
}
