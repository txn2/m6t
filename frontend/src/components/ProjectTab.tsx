import { useEffect, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Project } from "../lib/projects";
import { PROJECT_COLORS, projectColor, projectLabel } from "../lib/projects";
import { UiIcon } from "./Icon";

export interface ProjectTabProps {
  readonly project: Project;
  readonly active: boolean;
  readonly editing: boolean;
  onSelect: (name: string) => void;
  onEdit: (name: string | null) => void;
  onRename: (name: string, label: string) => void;
  onColor: (name: string, color: string) => void;
  onRemove: (name: string) => void;
}

/**
 * One project tab: its label, its accent colour, the menu that changes both,
 * and its half of the strip's drag-to-reorder (#41).
 *
 * The two hard parts are delegated rather than written here. `useSortable`
 * (dnd-kit) owns the drag: the transform that follows the pointer, the
 * transition that slides the displaced tabs, the distance threshold that keeps
 * a click a click, and keyboard reordering. Radix owns the context menu:
 * placement that avoids the window edges, Escape, click-outside, focus return
 * and arrow-key navigation.
 *
 * The colour is carried as `data-color` rather than as an inline style. The
 * stylesheet owns the palette, so a colour name this build does not know — from
 * a projects.yaml someone edited by hand, which DESIGN.md §4 invites — is a tab
 * with no dot, and no value out of a config file is ever interpolated into CSS.
 */
export function ProjectTab({
  project,
  active,
  editing,
  onSelect,
  onEdit,
  onRename,
  onColor,
  onRemove,
}: ProjectTabProps) {
  const label = projectLabel(project);
  const color = projectColor(project.color);
  // Radix returns focus to the trigger when the menu closes, which would take
  // it straight back off the rename field that opened in the same breath.
  const renaming = useRef(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: project.name,
    // A tab is not "a draggable item" to someone listening to this app; it is
    // a project tab, and that is what the screen reader should say.
    attributes: { roleDescription: "project tab" },
    // Renaming happens in a field that lives inside the tab. A drag armed
    // underneath it would fight the caret.
    disabled: editing,
  });

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <li
          ref={setNodeRef}
          data-project={project.name}
          className={`projects__tab${active ? " projects__tab--active" : ""}${
            isDragging ? " projects__tab--dragging" : ""
          }`}
          style={{ transform: CSS.Translate.toString(transform), transition }}
        >
          {editing ? (
            <NameField
              initial={label}
              ariaLabel={`rename ${label}`}
              className="projects__rename"
              onCommit={(next) => {
                onRename(project.name, next);
                onEdit(null);
              }}
              onCancel={() => {
                onEdit(null);
              }}
            />
          ) : (
            <button
              type="button"
              ref={setActivatorNodeRef}
              className="projects__select"
              aria-current={active ? "page" : undefined}
              title={project.path}
              onClick={() => {
                onSelect(project.name);
              }}
              {...attributes}
              {...listeners}
            >
              {color !== null && (
                <span className="projects__dot" data-color={color} aria-hidden="true" />
              )}
              {label}
            </button>
          )}
          <button
            type="button"
            className="projects__remove"
            aria-label={`Remove ${label} from the project list`}
            title="Remove from the list — the repository on disk is untouched"
            onClick={() => {
              onRemove(project.name);
            }}
          >
            <UiIcon name="close" />
          </button>
        </li>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content
          className="projects__menu"
          aria-label={`${label} actions`}
          // Rename opens its field HERE rather than in the item's onSelect,
          // because an open menu makes everything outside it inert: a field
          // mounted while the menu was still closing took focus and lost it
          // again half a frame later, which committed the rename the user had
          // not typed yet. By this point the menu is gone, and preventDefault
          // stops Radix putting focus back on the tab it just left.
          onCloseAutoFocus={(event) => {
            if (renaming.current) {
              renaming.current = false;
              event.preventDefault();
              onEdit(project.name);
            }
          }}
        >
          <ContextMenu.Item
            className="projects__menu-item"
            onSelect={() => {
              renaming.current = true;
            }}
          >
            Rename
          </ContextMenu.Item>

          {/* A radio group rather than a submenu: there are seven choices and
              picking one should cost a single click. Radix gives the group
              arrow-key navigation and the checked state for free. */}
          <ContextMenu.RadioGroup
            className="projects__swatches"
            value={color ?? ""}
            onValueChange={(next) => {
              onColor(project.name, next);
            }}
          >
            {PROJECT_COLORS.map((swatch) => (
              <ContextMenu.RadioItem
                key={swatch}
                value={swatch}
                aria-label={swatch}
                className="projects__swatch"
                data-color={swatch}
              />
            ))}
            <ContextMenu.RadioItem value="" aria-label="no colour" className="projects__swatch" />
          </ContextMenu.RadioGroup>

          <ContextMenu.Item
            className="projects__menu-item"
            onSelect={() => {
              onRemove(project.name);
            }}
          >
            Remove from the list
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export interface NameFieldProps {
  readonly initial: string;
  readonly ariaLabel: string;
  readonly className: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/**
 * The strip's inline text field: naming a project on the way in, and renaming
 * one afterwards.
 *
 * Blur commits rather than cancels, which is the terminal strip's rule and the
 * opposite of the file tree's (InlineField.tsx). The distinction is what is at
 * the other end: a stray click that renames a tab costs a second right-click,
 * where one that creates a file costs a file. Naming a project on the way in
 * commits for a second reason — the directory has already been chosen, and
 * discarding that would send the user back through the picker.
 *
 * It is exported from this module rather than from the strip because the strip
 * imports this one; the other direction would be a cycle.
 */
export function NameField({ initial, ariaLabel, className, onCommit, onCancel }: NameFieldProps) {
  const [draft, setDraft] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  // The field ends exactly once. Escape removes a focused input, and a blur
  // that arrived on the way out would commit the edit the user just abandoned.
  const settled = useRef(false);

  // Focus, then select: select() alone is not specified to move focus, and a
  // field the keyboard cannot reach is one Enter and Escape never arrive at.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const settle = (end: () => void) => {
    if (!settled.current) {
      settled.current = true;
      end();
    }
  };

  return (
    <input
      ref={field}
      className={className}
      type="text"
      value={draft}
      aria-label={ariaLabel}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={() => {
        settle(() => {
          onCommit(draft);
        });
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          settle(() => {
            onCommit(draft);
          });
        } else if (event.key === "Escape") {
          settle(onCancel);
        }
      }}
    />
  );
}
