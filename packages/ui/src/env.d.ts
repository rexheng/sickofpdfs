// What the bundler (Vite, WXT, Vitest) adds to the type system for the imports used in this package.
declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*.module.css' {
  const classes: { readonly [name: string]: string };
  export default classes;
}

// Side-effect imports of plain CSS: `import './base.css'`
declare module '*.css';
