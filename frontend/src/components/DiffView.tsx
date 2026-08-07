import { diffLines, omitted } from "../lib/pipeline";

export interface DiffViewProps {
  /** `kubectl diff`'s stdout, verbatim. */
  readonly output: string;
}

/**
 * `kubectl diff` output, rendered as the unified diff it is (DESIGN.md §6.1).
 *
 * It renders what kubectl printed rather than reconstructing it. The tool
 * already produced the diff the user would have got at their own prompt, and
 * re-deriving one from two object trees would be m6t showing a change kubectl
 * disagreed about — which is the one thing a preview must never do.
 *
 * The colours are the only thing added, and they carry a sign as well: a
 * removal keeps its `-` and an addition its `+`, so the pane is still readable
 * when it is copied out of the window as text, and still readable to someone
 * who cannot tell the two colours apart.
 *
 * This is not #35's diff viewer and should not become it. That one compares a
 * working tree against HEAD, in the editor, with the git service behind it;
 * this one paints a string a subprocess printed.
 */
export function DiffView({ output }: DiffViewProps) {
  const lines = diffLines(output);
  const dropped = omitted(output);

  return (
    <div className="diff" role="group" aria-label="Cluster diff">
      <pre className="diff__body">
        {lines.map((line, index) => (
          <span
            // The index is the identity: a diff line has no other, and the
            // list is replaced whole whenever the output changes.
            key={`${String(index)}:${line.text}`}
            className="diff__line"
            data-kind={line.kind}
          >
            {line.text === "" ? " " : line.text}
          </span>
        ))}
      </pre>

      {/* Said rather than silently cut. A viewer that truncated without
          admitting it would show a short diff for a large change, which is the
          most dangerous kind of preview there is. */}
      {dropped > 0 && (
        <p className="diff__truncated">
          {dropped} more line{dropped === 1 ? "" : "s"} not shown. Run the
          command below in a terminal to read all of it.
        </p>
      )}
    </div>
  );
}
