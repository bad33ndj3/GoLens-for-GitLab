// Synthetic large-diff DOM builder, matching the Rapid Diffs markup shape
// `go-navigation.js` looks for:
//   - file roots: `diff-file[data-testid="rd-diff-file"]` with a
//     `data-file-data` JSON attribute (old_path/new_path)
//   - code cells: `[data-testid="rd-diff-line-content"]`
//   - blob links: `a[href*="/-/blob/"]`
//
// Exported so UI/perf tests beyond this benchmark suite can reuse the same
// large-diff fixture instead of re-deriving GitLab's markup shape.
//
// Deterministic: no randomness, no clock reads.

const GITLAB_ORIGIN = 'https://gitlab.example';
const PROJECT_PATH = 'group/project';

function pad(value) {
  return String(value).padStart(3, '0');
}

/**
 * Builds one Rapid Diffs `<diff-file>` root with `rowsPerFile` code rows.
 * Each row's code cell repeats a small set of identifiers (`Client`, `New`,
 * `Err`) that also appear as substrings of longer identifiers
 * (`ClientNNN`), exercising the identifier-boundary check in
 * `occurrenceRanges`/`identifierAtCharacter`.
 */
function buildFileMarkup(fileIndex, rowsPerFile, sha) {
  const path = `pkg${pad(fileIndex)}/file${pad(fileIndex)}.go`;
  const typeName = `Client${pad(fileIndex)}`;
  const fileData = JSON.stringify({ viewer: 'text_inline', old_path: path, new_path: path });
  const blobHref = `${GITLAB_ORIGIN}/${PROJECT_PATH}/-/blob/${sha}/${path}`;

  const rows = [];
  for (let rowIndex = 0; rowIndex < rowsPerFile; rowIndex++) {
    const line = rowIndex + 1;
    // Mix of: a bare "Client"/"New"/"Err" occurrence, a struct literal that
    // *contains* "Client" as a substring (ClientNNN) to exercise the
    // boundary check, and a couple of markup elements per row so the
    // TreeWalker has multiple text nodes to visit per cell.
    rows.push(`
      <tr class="rd-diff-line">
        <td class="rd-line-number" data-position="new"><a class="rd-line-link" data-line-number="${line}" aria-label="Added line ${line}">${line}</a></td>
        <td data-testid="rd-diff-line-content" class="rd-diff-code">
          <span class="kw">func</span> <span class="fn">New</span>() *<span class="tp">${typeName}</span> {
          <span class="id">c</span> := <span class="id">Client</span>.<span class="id">New</span>()
          <span class="id">Err</span> = <span class="id">c</span>.<span class="id">Err</span>()
          <span class="id">c</span>.<span class="id">Client</span>()
          return &amp;<span class="tp">${typeName}</span>{}
          }
        </td>
      </tr>`);
  }

  return `
    <diff-file data-testid="rd-diff-file" data-file-data='${fileData}'>
      <article class="rd-diff-file">
        <header class="rd-diff-file-header" data-testid="rd-diff-file-header">
          <h2 class="rd-diff-file-title"><a class="rd-diff-file-link" href="${blobHref}">${path}</a></h2>
        </header>
        <table><tbody>${rows.join('')}</tbody></table>
      </article>
    </diff-file>`;
}

/**
 * @param {{ fileCount?: number, rowsPerFile?: number, sha?: string }} [options]
 * @returns {string} HTML for `fileCount` diff-file roots x `rowsPerFile` code rows each.
 */
export function buildDiffFixtureHTML({ fileCount = 60, rowsPerFile = 120, sha = 'f'.repeat(40) } = {}) {
  const files = [];
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    files.push(buildFileMarkup(fileIndex, rowsPerFile, sha));
  }
  return `<div id="diffs">${files.join('')}</div>`;
}
