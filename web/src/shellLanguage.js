// Shell-editor smarts for Monaco: theme, deploy-oriented snippets, $VAR completion and a light linter.

let envKeys = [];
export function setEnvKeys(keys) {
  envKeys = keys.filter(Boolean);
}

const CI_VARS = [
  ['CI', 'Always "true" inside a pipeline'],
  ['CI_WORKSPACE', 'Pipeline workspace directory on this agent (persists between runs)'],
  ['CI_RUN_ID', 'Unique id of this run'],
  ['CI_RUN_NUMBER', 'Incrementing run number for this pipeline'],
  ['CI_PIPELINE_NAME', 'Name of the pipeline'],
  ['CI_JOB_ID', 'Id of this job (one per agent)'],
  ['CI_AGENT_NAME', 'Name of the agent running the job'],
  ['CI_STEP_NAME', 'Name of the current step'],
  ['CI_STEP_INDEX', 'Zero-based index of the current step'],
  ['CI_TRIGGER', 'manual | webhook'],
  ['CI_TRIGGERED_BY', 'User who started the run'],
  ['CI_TRIGGER_PAYLOAD', 'JSON body of the webhook that started the run'],
  ['HOME', 'Home directory of the agent user'],
  ['PATH', 'Executable search path'],
  ['USER', 'Agent user'],
  ['PWD', 'Current directory'],
];

const SNIPPETS = [
  ['strict', 'Fail fast: exit on error, unset vars and pipe failures', 'set -euo pipefail\n$0'],
  ['if', 'if statement', 'if [ ${1:condition} ]; then\n\t$0\nfi'],
  ['ifelse', 'if / else', 'if [ ${1:condition} ]; then\n\t${2}\nelse\n\t$0\nfi'],
  ['iffile', 'if file exists', 'if [ -f "${1:path}" ]; then\n\t$0\nfi'],
  ['ifdir', 'if directory exists', 'if [ -d "${1:path}" ]; then\n\t$0\nfi'],
  ['for', 'for loop', 'for ${1:item} in ${2:list}; do\n\t$0\ndone'],
  ['while', 'while loop', 'while ${1:condition}; do\n\t$0\ndone'],
  ['case', 'case statement', 'case "${1:\\$VAR}" in\n\t${2:pattern})\n\t\t$0\n\t\t;;\n\t*)\n\t\t;;\nesac'],
  ['func', 'function', '${1:name}() {\n\t$0\n}'],
  ['section', 'Print a section header in the log', 'echo -e "\\n\\033[1;36m==> ${1:Building}\\033[0m"'],
  ['retry', 'Retry a command N times', 'retry() {\n\tlocal n=0 max=${1:5}\n\tshift\n\tuntil "\\$@"; do\n\t\tn=\\$((n+1))\n\t\t[ \\$n -ge \\$max ] && return 1\n\t\techo "Retry \\$n/\\$max..."; sleep \\$((n*2))\n\tdone\n}\nretry ${1} ${2:command}'],
  ['git-sync', 'Clone a repo, or fetch + hard reset if it exists', 'REPO_DIR="${1:app}"\nBRANCH="${2:main}"\nif [ -d "\\$REPO_DIR/.git" ]; then\n\tgit -C "\\$REPO_DIR" fetch --prune origin\n\tgit -C "\\$REPO_DIR" checkout "\\$BRANCH"\n\tgit -C "\\$REPO_DIR" reset --hard "origin/\\$BRANCH"\nelse\n\tgit clone --branch "\\$BRANCH" ${3:git@github.com:org/repo.git} "\\$REPO_DIR"\nfi\ncd "\\$REPO_DIR"\necho "Deploying commit \\$(git rev-parse --short HEAD)"'],
  ['npm-build', 'Install deps and build a Node project', 'node -v && npm -v\nnpm ci\nnpm run ${1:build}\n$0'],
  ['npm-test', 'Run tests', 'npm test -- ${1:--ci}'],
  ['pm2-reload', 'Zero-downtime reload with PM2', 'pm2 reload ${1:ecosystem.config.js} --update-env || pm2 start ${1}\npm2 save'],
  ['systemd-restart', 'Restart a systemd service and show status', 'sudo systemctl restart ${1:myapp}\nsudo systemctl --no-pager status ${1} | head -n 20'],
  ['docker-build', 'Build and tag a Docker image', 'IMAGE="${1:registry.example.com/app}"\nTAG="\\${CI_RUN_NUMBER:-latest}"\ndocker build -t "\\$IMAGE:\\$TAG" -t "\\$IMAGE:latest" ${2:.}'],
  ['docker-push', 'Login and push an image', 'echo "\\$${1:REGISTRY_PASSWORD}" | docker login ${2:registry.example.com} -u "\\$${3:REGISTRY_USER}" --password-stdin\ndocker push "\\$IMAGE:\\$TAG"\ndocker push "\\$IMAGE:latest"'],
  ['compose-up', 'Pull and restart a docker compose stack', 'docker compose -f ${1:docker-compose.yml} pull\ndocker compose -f ${1} up -d --remove-orphans\ndocker image prune -f'],
  ['healthcheck', 'Wait until a URL returns 2xx', 'URL="${1:http://localhost:3000/health}"\nfor i in \\$(seq 1 ${2:30}); do\n\tif curl -fsS "\\$URL" > /dev/null; then echo "Healthy"; exit 0; fi\n\techo "Waiting for \\$URL (\\$i)..."; sleep 2\ndone\necho "Health check failed" >&2\nexit 1'],
  ['release-dir', 'Atomic release folder + current symlink', 'RELEASES="${1:/var/www/app/releases}"\nNEW="\\$RELEASES/\\$(date +%Y%m%d%H%M%S)"\nmkdir -p "\\$NEW"\nrsync -a --delete ${2:dist/} "\\$NEW/"\nln -sfn "\\$NEW" "${3:/var/www/app/current}"\n# keep the 5 newest releases\nls -1dt "\\$RELEASES"/* | tail -n +6 | xargs -r rm -rf'],
  ['backup', 'Tar.gz backup of a directory', 'BACKUP="${1:/var/backups}/${2:app}-\\$(date +%F-%H%M).tar.gz"\ntar -czf "\\$BACKUP" -C ${3:/var/www} ${2}\necho "Backup written to \\$BACKUP"'],
  ['rsync-deploy', 'Copy build output to a remote host', 'rsync -az --delete ${1:dist/} ${2:deploy@host}:${3:/var/www/app/}'],
  ['nginx-reload', 'Test config and reload nginx', 'sudo nginx -t && sudo systemctl reload nginx'],
  ['require-var', 'Fail if a variable is empty', ': "\\${${1:VAR}:?${1} must be set}"'],
];

let registered = false;

export function setupShell(monaco) {
  if (registered) return;
  registered = true;

  monaco.editor.defineTheme('shipyard', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'string', foreground: 'a5d6a7' },
      { token: 'keyword', foreground: 'f59e0b' },
      { token: 'variable', foreground: '7dd3fc' },
      { token: 'number', foreground: 'f9a8d4' },
    ],
    colors: {
      'editor.background': '#0b0d10',
      'editor.lineHighlightBackground': '#14181d',
      'editorLineNumber.foreground': '#3b424b',
      'editorLineNumber.activeForeground': '#9aa4af',
      'editorGutter.background': '#0b0d10',
      'editor.selectionBackground': '#f59e0b33',
      'editorCursor.foreground': '#f59e0b',
    },
  });

  monaco.languages.registerCompletionItemProvider('shell', {
    triggerCharacters: ['$', '{'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      const K = monaco.languages.CompletionItemKind;

      if (/\$\{?$/.test(before)) {
        const seen = new Set();
        const vars = [...envKeys.map((k) => [k, 'Pipeline environment variable']), ...CI_VARS]
          .filter(([k]) => !seen.has(k) && seen.add(k));
        return {
          suggestions: vars.map(([name, doc], i) => ({
            label: name,
            kind: K.Variable,
            insertText: name,
            documentation: doc,
            sortText: String(i).padStart(3, '0'),
            range,
          })),
        };
      }

      return {
        suggestions: SNIPPETS.map(([label, doc, body]) => ({
          label,
          kind: K.Snippet,
          detail: doc,
          documentation: { value: '```bash\n' + body.replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\$\d/g, '').replace(/\\\$/g, '$') + '\n```' },
          insertText: body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      };
    },
  });
}

/** Very small linter for common deploy-script mistakes. Returns Monaco markers. */
export function lintShell(monaco, text) {
  const S = monaco.MarkerSeverity;
  const markers = [];
  const lines = text.split('\n');
  const mark = (line, msg, sev, startCol = 1, endCol) => markers.push({
    startLineNumber: line, endLineNumber: line, startColumn: startCol,
    endColumn: endCol || (lines[line - 1]?.length || 1) + 1, message: msg, severity: sev,
  });

  const code = lines.map((l) => l.replace(/(^|\s)#.*$/, ''));
  const hasStrict = /\bset\s+-[a-z]*e/.test(text) || /\bset\s+-o\s+errexit/.test(text);
  const nonEmpty = code.filter((l) => l.trim()).length;

  if (text.includes('\r')) mark(1, 'Windows line endings (CRLF) detected — they are converted on the agent, but check your source.', S.Warning);
  if (!hasStrict && nonEmpty > 1) mark(1, 'Tip: add `set -euo pipefail` so the step stops at the first failing command (type "strict").', S.Info);

  code.forEach((l, i) => {
    const n = i + 1;
    if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\/(\s|$|\*)/.test(l)) mark(n, 'This deletes from the filesystem root!', S.Error);
    const m = l.match(/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+"?\$\{?([A-Za-z_]\w*)\}?"?\//);
    if (m) mark(n, `If $${m[1]} is empty this becomes "rm -r /…". Use "\${${m[1]}:?}" to guard it.`, S.Warning);
    if (!hasStrict && /^\s*cd\s+\S+\s*$/.test(l)) mark(n, '`cd` without `|| exit 1` — later commands run in the wrong folder if it fails.', S.Warning);
    if (/^\s*sudo\s/.test(l) && !/sudo\s+-n\b/.test(l)) mark(n, 'sudo may wait for a password and hang the job. Configure NOPASSWD for the agent user or use `sudo -n`.', S.Info);
    if (/\bread\s+(-[a-z]+\s+)*\w+\s*$/.test(l)) mark(n, '`read` waits for input — jobs have no stdin.', S.Warning);
    const quotes = (l.replace(/\\"/g, '').replace(/'[^']*'/g, '').match(/"/g) || []).length;
    if (quotes % 2 === 1 && !/\\$/.test(l)) mark(n, 'Unbalanced double quote on this line (fine if the string continues on the next line).', S.Hint);
  });

  const count = (re) => code.reduce((a, l) => a + (l.match(re) || []).length, 0);
  const pairs = [[/(^|;|\s)if\s/g, /(^|;|\s)fi\b/g, 'if', 'fi'], [/(^|;|\s)case\s/g, /(^|;|\s)esac\b/g, 'case', 'esac'], [/(^|;|\s)do\b/g, /(^|;|\s)done\b/g, 'do', 'done']];
  for (const [open, close, o, c] of pairs) {
    const a = count(open); const b = count(close);
    if (a !== b) mark(lines.length, `${a} \`${o}\` but ${b} \`${c}\` — a block is not closed.`, S.Warning);
  }
  return markers;
}
