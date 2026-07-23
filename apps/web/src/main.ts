import { createApp } from 'vue';

import App from './App.vue';
import { bootstrapApplication } from './app/bootstrap/bootstrap';
import { bootstrapStateKey } from './app/bootstrap/bootstrap-state';
import { router } from './router';
import './styles/app.css';

const bootstrapState = await bootstrapApplication();

createApp(App).provide(bootstrapStateKey, bootstrapState).use(router).mount('#app');
