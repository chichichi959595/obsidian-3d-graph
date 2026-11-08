import { getLanguage } from 'obsidian';
import type { AnalogyFailure } from './analogy.ts';

const en = {
  analogy: {
    'unsupported-platform': 'Notes Graph 3D needs Analogy, which only supports macOS and Windows.',
    'not-indexed': 'No Analogy index found for this vault. Install Analogy and let it finish indexing.',
    'unsupported-version': 'This version of Analogy is not supported yet. Update Notes Graph 3D.',
    empty: 'Analogy has not indexed any notes yet. Open this again when indexing has finished.',
  } as Record<AnalogyFailure, string>,
  ribbon: 'Open Notes Graph 3D',
  commandOpen: 'Open 3D graph in browser',
  commandRebuild: 'Rebuild 3D graph',
  portBusy: (port: number) => `Port ${port} is already in use. Change it in the Notes Graph 3D settings.`,
  serverFailed: 'Could not start the Notes Graph 3D local server.',
  building: 'Building the 3D graph…',
  buildFailed: 'Could not build the 3D graph. Details are in error.log.',
  portName: 'Local port',
  portDesc: 'The port your browser connects to. After changing it, the browser asks for camera permission again.',
};

const zh: typeof en = {
  analogy: {
    'unsupported-platform': 'Notes Graph 3D 需要 Analogy，而 Analogy 目前只支援 macOS 和 Windows。',
    'not-indexed': '找不到這個 vault 的 Analogy 索引。請先安裝 Analogy 並完成索引。',
    'unsupported-version': '這個版本的 Analogy 尚未支援，請更新 Notes Graph 3D。',
    empty: 'Analogy 還沒有索引任何筆記。請等索引完成後再開啟。',
  },
  ribbon: '開啟 Notes Graph 3D',
  commandOpen: '在瀏覽器開啟 3D 筆記圖',
  commandRebuild: '重新建立 3D 筆記圖',
  portBusy: (port) => `連接埠 ${port} 已被佔用。請到 Notes Graph 3D 設定更換。`,
  serverFailed: '無法啟動 Notes Graph 3D 的本機服務。',
  building: '正在建立 3D 筆記圖…',
  buildFailed: '建立 3D 筆記圖失敗，詳情已記錄到 error.log。',
  portName: '本機連接埠',
  portDesc: '瀏覽器連線用的連接埠。更改後，瀏覽器會重新詢問攝影機權限。',
};

/** Follows Obsidian's own language, which only changes on restart. */
export const s = getLanguage().toLowerCase().startsWith('zh') ? zh : en;
