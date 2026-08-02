# EmberProbe 发布指南

推送稳定版本标签后，[Release 工作流](../.github/workflows/release.yml)会验证版本、运行质量门禁、生成 VSIX，并自动创建 GitHub Release 和上传附件。

## 权限与安全

无需配置额外 Secret。工作流只在发布 job 中申请 `contents: write`，并使用 GitHub 自动提供的短期 `GITHUB_TOKEN` 创建 Release。建议保护 `v*` 标签，防止未审查的提交触发发布。

## 发布稳定版本

以下示例发布 `0.5.0`：

```powershell
npm run release:prepare -- 0.5.0 --date 2026-07-31
npm run check
npm run quality
git add package.json package-lock.json README.md README_EN.md CHANGELOG.md
git commit -m "chore: prepare v0.5.0"
git tag -a v0.5.0 -m "EmberProbe v0.5.0"
git push origin main
git push origin v0.5.0
```

标签必须严格使用 `vX.Y.Z`，并与 `package.json`、lock 文件、README 和 Changelog 一致。预发布标签（例如 `v0.5.0-beta.1`）会被拒绝，避免意外覆盖稳定渠道。

工作流依次执行：

1. 校验标签和发布元数据。
2. 执行单元测试、质量门禁和 Extension Host 冒烟测试。
3. 打包并保存 `dist/emberprobe.vsix`。
4. 创建 GitHub Draft Release 并上传 VSIX。
5. 附件上传成功后将 Draft Release 转为正式 Release。

## 失败与重试

如果创建 Release、上传附件或公开草稿失败，在 GitHub **Actions → Release → Run workflow** 中输入原标签重跑。

工作流可安全处理常见重试场景：

- Draft Release 已存在时会复用并更新 VSIX。
- GitHub Release 已经公开时会直接结束，不重复发布。

不要删除已经发布的标签后用同一版本指向其他提交；发布构件应保持不可变。
