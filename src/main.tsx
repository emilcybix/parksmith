import { createRoot } from 'react-dom/client';
import { startSettingsSync } from './settings';
import { App } from './ui/App';
import { startSettingsDom } from './ui/settingsDom';
import './ui/styles.css';
// After styles.css on purpose: the accessibility layer overrides focus rings and muted text colours.
import './ui/a11y.css';

// Settings load synchronously at import; apply them to <html> before the first paint, then follow
// changes (including other tabs) for the life of the page.
startSettingsDom();
startSettingsSync();

createRoot(document.getElementById('root')!).render(<App />);
