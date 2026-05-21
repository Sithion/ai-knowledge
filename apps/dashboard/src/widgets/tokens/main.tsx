import React from 'react';
import ReactDOM from 'react-dom/client';
import '../shared/widget.css';
import { TokenConsumptionWidget } from './TokenConsumptionWidget.js';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TokenConsumptionWidget />
  </React.StrictMode>,
);
