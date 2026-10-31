import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import '../monacoSetup';
import { lintShell, setupShell } from '../shellLanguage';

export default function ShellEditor({ value, onChange, shell = 'bash', height = 260 }) {
  const [full, setFull] = useState(false);
  const [problems, setProblems] = useState(0);
  const lintRef = useRef(null);
  const language = shell === 'pwsh' ? 'powershell' : 'shell';

  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [full]);

  useEffect(() => { lintRef.current?.(); }, [language]);

  const onMount = (editor, monaco) => {
    const lint = () => {
      const model = editor.getModel();
      if (!model) return;
      const markers = model.getLanguageId() === 'shell' ? lintShell(monaco, model.getValue()) : [];
      monaco.editor.setModelMarkers(model, 'shipyard-lint', markers);
      setProblems(markers.filter((m) => m.severity >= monaco.MarkerSeverity.Warning).length);
    };
    lintRef.current = lint;
    editor.onDidChangeModelContent(lint);
    lint();
  };

  return (
    <div className={`editor-wrap ${full ? 'fullscreen' : ''}`}>
      <div className="editor-toolbar">
        <span className="editor-lang">{language === 'powershell' ? 'PowerShell' : shell}</span>
        {problems > 0 && <span className="editor-problems">{problems} warning{problems > 1 ? 's' : ''}</span>}
        <span className="editor-hint">Ctrl+Space snippets · $ variables · Ctrl+/ comment · F1 commands</span>
        <button type="button" className="btn ghost sm" onClick={() => setFull((f) => !f)}>
          {full ? 'Exit full screen (Esc)' : 'Full screen'}
        </button>
      </div>
      <Editor
        height={full ? 'calc(100vh - 41px)' : height}
        language={language}
        theme="shipyard"
        value={value}
        onChange={(v) => onChange(v ?? '')}
        beforeMount={setupShell}
        onMount={onMount}
        options={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 13,
          lineHeight: 20,
          minimap: { enabled: full },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          insertSpaces: true,
          renderWhitespace: 'boundary',
          wordWrap: 'on',
          padding: { top: 10, bottom: 10 },
          quickSuggestions: { other: true, comments: false, strings: true },
          suggestOnTriggerCharacters: true,
          snippetSuggestions: 'top',
          fixedOverflowWidgets: true,
          stickyScroll: { enabled: false },
        }}
      />
    </div>
  );
}
