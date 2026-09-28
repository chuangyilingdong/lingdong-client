import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lingdongGate", {
  login: (login: string, password: string) => ipcRenderer.invoke("lingdong:gate-login", { login, password }),
  retry: () => ipcRenderer.invoke("lingdong:gate-retry"),
});
