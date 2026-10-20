import './styles/theme.css';
import { createApp } from 'vue';
import App from './App.vue';
import { applyTheme, getTheme } from './lib/theme';

applyTheme(getTheme());

createApp(App).mount('#app');