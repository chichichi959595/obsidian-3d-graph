export type Language = 'en' | 'zh';

const STORAGE_KEY = 'notes-graph-3d-language';

function savedLanguage(): Language | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'en' || value === 'zh' ? value : null;
  } catch {
    return null;
  }
}

export const language: Language = savedLanguage() ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');

const en = {
  graphLabel: '3D network of notes',
  legendLabel: 'Colour legend',
  addGroup: '+ Add group',
  legendFull: 'Limit of 8 groups reached',
  addPlaceholder: 'Folder or tag',
  noSuggestions: 'No folder or tag matches.',
  legendSaveFailed: 'Could not save the legend. Check that Obsidian is open.',
  other: 'Other',
  controlsLabel: 'Controls',
  search: 'Search notes',
  layoutLabel: 'Layout',
  layoutCloud: 'Cloud',
  layoutGlobe: 'Sphere',
  layoutRing: 'Ring',
  edgesLabel: 'Connections shown',
  edgeSemantic: 'Similar',
  edgeLinks: 'Links',
  gestures: 'Gestures',
  download: 'Download',
  retry: 'Retry',
  gestureHelp:
    'Point your index finger at a dot and hold for 3 seconds to open it; buttons take 1 second. Make a fist, then spread your fingers to exit a selection. Pinch and drag to rotate. Pinch with both hands and pull apart to zoom.',
  closePanel: 'Close note details',
  openInObsidian: 'Open in Obsidian',
  similarNotes: 'Similar notes',
  linkedNotes: 'Linked notes',
  otherLanguage: '中文',
  switchLanguage: 'Switch to Chinese',

  gestureNone: 'Hold your hand up to the camera.',
  gestureOpen: 'Point your index finger to aim, or pinch to rotate.',
  gestureAim: 'Aiming. Hold still to select.',
  gestureGrab: 'Rotating.',
  gestureZoom: 'Zooming.',
  cameraDenied: 'The camera is blocked. Allow it in the address bar, then turn on hand gestures again.',
  cameraMissing: 'No camera found. Check that one is connected and not in use by another app.',
  modelFailed: 'The hand model failed to load. Reload this page and try again.',
  noGraph: 'Note data not found. Reopen Notes Graph 3D from Obsidian.',
  noWebgl: 'This browser cannot use WebGL 2. Turn on hardware acceleration or use the latest Chrome.',
  startingCamera: 'Starting the camera and hand model.',
  noMatches: 'No matching notes. Try other words from the title.',

  stats: (notes: string, chunks: string) => `${notes} notes, ${chunks} passages`,
  downloadFailed: (message: string) => `Download failed: ${message}`,
  downloadNeeded: (mb: number) => `Hand gestures need a one-time download of the hand model, about ${mb} MB.`,
  downloading: (percent: number) => `Downloading the hand model: ${percent}%`,
  noteMeta: (parts: string[], chunks: number, date: string) =>
    [...parts, `${chunks} ${chunks === 1 ? 'passage' : 'passages'}`, `updated ${date}`].join(', '),
  similarity: (title: string, value: string) => `${title}, similarity ${value}`,
  removeGroup: (name: string) => `Remove ${name}`,
};

const zh: typeof en = {
  graphLabel: '筆記的 3D 網絡',
  legendLabel: '顏色圖例',
  addGroup: '+ 新增分組',
  legendFull: '已達 8 個分組的上限',
  addPlaceholder: '資料夾或標籤',
  noSuggestions: '沒有符合的資料夾或標籤。',
  legendSaveFailed: '無法儲存圖例。請確認 Obsidian 還開著。',
  other: '其他',
  controlsLabel: '控制台',
  search: '搜尋筆記',
  layoutLabel: '排列方式',
  layoutCloud: '星雲',
  layoutGlobe: '球殼',
  layoutRing: '環形',
  edgesLabel: '顯示的連線',
  edgeSemantic: '內容相近',
  edgeLinks: '筆記連結',
  gestures: '手勢控制',
  download: '下載',
  retry: '重試',
  gestureHelp: '伸出食指指向節點，停住 3 秒可開啟，按鈕只要 1 秒。握拳後張開五指可退出選取。捏住拖曳可旋轉，雙手捏住拉開可縮放。',
  closePanel: '關閉筆記資訊',
  openInObsidian: '在 Obsidian 開啟',
  similarNotes: '內容相近',
  linkedNotes: '筆記連結',
  otherLanguage: 'English',
  switchLanguage: '切換為英文',

  gestureNone: '把手舉到攝影機前面。',
  gestureOpen: '伸出食指可瞄準，捏住可旋轉。',
  gestureAim: '瞄準中，停住即可選取。',
  gestureGrab: '旋轉中。',
  gestureZoom: '縮放中。',
  cameraDenied: '無法使用攝影機。請在網址列允許攝影機權限，再按一次手勢控制。',
  cameraMissing: '找不到可用的攝影機。請確認攝影機已連接，且沒有被其他程式佔用。',
  modelFailed: '手部模型載入失敗。請重新整理這個頁面後再試一次。',
  noGraph: '找不到筆記資料。請從 Obsidian 重新開啟 Notes Graph 3D。',
  noWebgl: '這個瀏覽器無法使用 WebGL 2。請開啟硬體加速，或改用最新版 Chrome。',
  startingCamera: '正在啟動攝影機與手部模型。',
  noMatches: '沒有符合的筆記，試試標題中的其他字詞。',

  stats: (notes, chunks) => `${notes} 篇筆記，${chunks} 個段落`,
  downloadFailed: (message) => `下載失敗：${message}`,
  downloadNeeded: (mb) => `手勢控制需要下載約 ${mb} MB 的手部模型，只需下載一次。`,
  downloading: (percent) => `正在下載手部模型 ${percent}%`,
  noteMeta: (parts, chunks, date) => [...parts, `${chunks} 個段落`, `${date} 更新`].join('，'),
  similarity: (title, value) => `${title}，相似度 ${value}`,
  removeGroup: (name) => `移除 ${name}`,
};

export const t = language === 'zh' ? zh : en;
export const dateLocale = language === 'zh' ? 'zh-TW' : 'en-US';

/** Fills in the text written in index.html, which is marked up with data-t attributes. */
export function translatePage(): void {
  document.documentElement.lang = language === 'zh' ? 'zh-Hant' : 'en';
  const lookup = (key: string | undefined) => t[key as keyof typeof t] as string;
  document.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => (el.textContent = lookup(el.dataset.t)));
  document.querySelectorAll<HTMLElement>('[data-t-aria]').forEach((el) => el.setAttribute('aria-label', lookup(el.dataset.tAria)));
  document.querySelectorAll<HTMLInputElement>('[data-t-placeholder]').forEach((el) => (el.placeholder = lookup(el.dataset.tPlaceholder)));
}

/** Reloads, since labels and legend are built once from the current language. */
export function switchLanguage(): void {
  try {
    localStorage.setItem(STORAGE_KEY, language === 'zh' ? 'en' : 'zh');
  } catch {
    return;
  }
  location.reload();
}
