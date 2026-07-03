declare module '*.md?url' {
  const url: string;
  export default url;
}

declare module '*?url' {
  const url: string;
  export default url;
}
