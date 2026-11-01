// What the bundler (Vite, WXT, Vitest) adds to the type system for the imports used in this package.
// `?url` imports come in through @sop/ui (the find bar's controls), which registers its fonts with them.
declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*.module.css' {
  const classes: { readonly [name: string]: string };
  export default classes;
}

// A plain stylesheet, imported for its side effect (the text layer's global classes).
declare module '*.css' {}
