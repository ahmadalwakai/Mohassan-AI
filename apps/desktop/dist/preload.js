"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
/** What the web app may learn about its host: enough to know it runs inside the desktop shell, nothing more. */
electron_1.contextBridge.exposeInMainWorld('mohassanDesktop', Object.freeze({
    shell: 'electron',
    platform: process.platform,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
}));
