本项目为一个高性能Mandelbrot Deep Zoom 静态前端可视化项目

- 用TypeScript + Vite + webgl2 + Rust WASM + 基于Web Worker的多线程
- 支持pan、zoom；url实时表示当前位置和缩放
- 不使用需要设置 COOP/COEP 请求头的 SharedArrayBuffer
- 保持全局单一算法路径，不为浅层缩放设置快速路径
- 算法尽可能高效、省内存
- 算法或实现卡住时联网查找相关资料，避免闭门造车
