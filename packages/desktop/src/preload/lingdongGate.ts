import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lingdongGate", {
  login: (login: string, password: string, sessionId?: string) => ipcRenderer.invoke("lingdong:gate-login", { login, password, sessionId }),
  retry: () => ipcRenderer.invoke("lingdong:gate-retry"),
});
