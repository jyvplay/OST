"use client";
import { fz } from "@/lib/uiscale";

import type { WindowState } from "@/lib/windowing/state";
import FilesModule from "./modules/Files";
import EditorModule from "./modules/Editor";
import TerminalModule from "./modules/Terminal";
import SshModule from "./modules/Ssh";
import FindModule from "./modules/Find";
import NotesModule from "./modules/Notes";
import BrowserModule from "./modules/Browser";
import PeekModule from "./modules/Peek";
import MediaModule from "./modules/Media";
import CaptureModule from "./modules/Capture";
import LensModule from "./modules/Lens";
import BeamModule from "./modules/Beam";
import TogetherModule from "./modules/Together";
import MessagesModule from "./modules/Messages";
import VaultModule from "./modules/Vault";
import PrivacyModule from "./modules/Privacy";
import BackupModule from "./modules/Backup";
import AlertsModule from "./modules/Alerts";
import MonitorModule from "./modules/Monitor";
import CalculatorModule from "./modules/Calculator";
import SettingsModule from "./modules/Settings";
import SpecModule from "./modules/Spec";
import ClockModule from "./modules/Clock";
import PlannerModule from "./modules/Planner";
import DevicesModule from "./modules/Devices";
import ShareModule from "./modules/Share";
import RoutinesModule from "./modules/Routines";
import ClipboardModule from "./modules/Clipboard";
import StorageModule from "./modules/Storage";
import LocalDiskModule from "./modules/LocalDisk";
import SpreadsheetModule from "./modules/Spreadsheet";
import WriterModule from "./modules/Writer";
import TablesModule from "./modules/Tables";
import WhiteboardModule from "./modules/Whiteboard";
import ContactsModule from "./modules/Contacts";
import VideoModule from "./modules/Video";
import MusicModule from "./modules/Music";
import MapsModule from "./modules/Maps";
import SlidesModule from "./modules/Slides";
import ImageEditorModule from "./modules/ImageEditor";
import VectorModule from "./modules/Vector";

/** The registry's id → component map. Adding a module means adding it here and
 *  in src/lib/registry.ts; nothing else in the shell needs to change. */
export default function ModuleHost({ win }: { win: WindowState }) {
  switch (win.module) {
    case "files": return <FilesModule win={win} />;
    case "editor": return <EditorModule win={win} />;
    case "terminal": return <TerminalModule win={win} />;
    case "ssh": return <SshModule win={win} />;
    case "find": return <FindModule win={win} />;
    case "notes": return <NotesModule win={win} />;
    case "browser": return <BrowserModule win={win} />;
    case "peek": return <PeekModule win={win} />;
    case "media": return <MediaModule win={win} />;
    case "capture": return <CaptureModule win={win} />;
    case "lens": return <LensModule win={win} />;
    case "beam": return <BeamModule win={win} />;
    case "together": return <TogetherModule win={win} />;
    case "messages": return <MessagesModule win={win} />;
    case "vault": return <VaultModule win={win} />;
    case "privacy": return <PrivacyModule win={win} />;
    case "backup": return <BackupModule win={win} />;
    case "alerts": return <AlertsModule win={win} />;
    case "monitor": return <MonitorModule win={win} />;
    case "calculator": return <CalculatorModule win={win} />;
    case "settings": return <SettingsModule win={win} />;
    case "spec": return <SpecModule win={win} />;
    case "clock": return <ClockModule win={win} />;
    case "planner": return <PlannerModule win={win} />;
    case "devices": return <DevicesModule win={win} />;
    case "share": return <ShareModule win={win} />;
    case "routines": return <RoutinesModule win={win} />;
    case "clipboard": return <ClipboardModule win={win} />;
    case "storage": return <StorageModule win={win} />;
    case "localdisk": return <LocalDiskModule win={win} />;
    case "sheet": return <SpreadsheetModule win={win} />;
    case "writer": return <WriterModule win={win} />;
    case "tables": return <TablesModule win={win} />;
    case "whiteboard": return <WhiteboardModule win={win} />;
    case "contacts": return <ContactsModule win={win} />;
    case "video": return <VideoModule win={win} />;
    case "music": return <MusicModule win={win} />;
    case "maps": return <MapsModule win={win} />;
    case "slides": return <SlidesModule win={win} />;
    case "imageedit": return <ImageEditorModule win={win} />;
    case "vector": return <VectorModule win={win} />;
    default:
      return <div style={{ padding: 16, fontSize: fz(12) }}>Unknown module: {win.module}</div>;
  }
}
