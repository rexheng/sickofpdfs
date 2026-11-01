// What the bundler (Vite, WXT, Vitest) adds to the type system for the imports used in this package.
declare module '*.module.css' {
  const classes: { readonly [name: string]: string };
  export default classes;
}

// A plain stylesheet, imported for its side effect (the text layer's global classes).
declare module '*.css' {}
