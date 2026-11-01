// What the bundler (Vite, WXT, Vitest) adds to the type system for the imports used in this package.
declare module '*.module.css' {
  const classes: { readonly [name: string]: string };
  export default classes;
}
