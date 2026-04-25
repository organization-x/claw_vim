import { useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { FileTree } from "./components/FileTree";
import { Editor } from "./components/Editor";
import { Terminal } from "./components/Terminal";
import { samples } from "./samples";
import "./App.css";

const sampleNames = Object.keys(samples);

function App() {
  const [path, setPath] = useState<string>(sampleNames[0]);

  return (
    <div className="app">
      <Group orientation="horizontal">
        <Panel defaultSize={18} minSize={10} className="pane">
          <FileTree active={path} files={sampleNames} onSelect={setPath} />
        </Panel>
        <Separator className="resize-handle" />
        <Panel defaultSize={48} minSize={20} className="pane">
          <Editor path={path} initialContent={samples[path]} />
        </Panel>
        <Separator className="resize-handle" />
        <Panel defaultSize={34} minSize={20} className="pane">
          <Terminal />
        </Panel>
      </Group>
    </div>
  );
}

export default App;
