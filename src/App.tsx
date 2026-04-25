import { Group, Panel, Separator } from "react-resizable-panels";
import { FileTree } from "./components/FileTree";
import { Editor } from "./components/Editor";
import { Terminal } from "./components/Terminal";
import "./App.css";

function App() {
  return (
    <div className="app">
      <Group orientation="horizontal">
        <Panel defaultSize={18} minSize={10} className="pane">
          <FileTree />
        </Panel>
        <Separator className="resize-handle" />
        <Panel defaultSize={48} minSize={20} className="pane">
          <Editor />
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
