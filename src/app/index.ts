// Re-export from bun module for backwards compatibility
// The app and bun modules are equivalent - all implementation is in bun/
export { Role, BunApp, createBunApp } from '../bun'

// Backwards-compatible aliases
export { BunApp as App, createBunApp as createApp } from '../bun'
