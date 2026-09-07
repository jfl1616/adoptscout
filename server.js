'use strict';

const path = require('path');
const express = require('express');
const petsRouter = require('./src/routes/pets');
const rescueGroups = require('./src/rescuegroupsService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Simple request log -- useful when this is running headless behind a reverse proxy and you
// need to check `docker logs` to see if requests are even arriving.
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

app.use('/api/pets', petsRouter);

/** Health check for Docker/Portainer and for a reverse proxy to confirm the container is up.
 * Also reports whether a real RESCUEGROUPS_API_KEY is configured, which is the #1 thing worth
 * checking after a fresh deploy -- if this says "mock", the env var didn't make it into the
 * container. */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    dataSource: rescueGroups.isConfigured() ? 'rescuegroups' : 'mock',
    timestamp: new Date().toISOString()
  });
});

// Static frontend (plain HTML/CSS/JS -- no build step) lives in /public.
app.use(express.static(path.join(__dirname, 'public')));

// Anything else that looks like a page request (not /api/...) falls back to index.html, so
// direct links/refreshes to e.g. /pet.html?id=123 work the same as navigating there client-side.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    next();
    return;
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`AdoptScout listening on port ${PORT}`);
  console.log(`Data source: ${rescueGroups.isConfigured() ? 'RescueGroups.org (live)' : 'mock/sample data'}`);
});
