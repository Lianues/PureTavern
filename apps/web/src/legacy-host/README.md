# Legacy Host

此目录只负责把 `/public/legacy` 中的原始 SillyTavern UI 隔离展示出来。

当前 Host 会：

1. 请求 `/legacy/index.html`；
2. 使用 `DOMParser` 创建不会执行脚本的内存文档；
3. 把原页面的 `<base href="/">` 在内存中改为 `/legacy/`；
4. 从内存副本删除所有 `<script>` 标签；
5. 通过无 `allow-scripts` 权限的 sandbox iframe `srcdoc` 展示；
6. 在外部隐藏不会自行消失的 `#preloader`。

因此旧 JavaScript 不会被请求或执行，也不会访问旧 API。原始 `/public/legacy` 文件不会被修改，仍由 SHA-256 清单校验。

新业务逻辑禁止加入本目录；后续兼容层应有明确生命周期，并在对应模块迁移后删除。
