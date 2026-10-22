# EmberProbe 发布指南

推送稳定版本标签后，[Release 工作流](../.github/workflows/release.yml)会验证版本、运行质量门禁、生成 VSIX，并自动创建 GitHub Release 和上传附件。

## 权限与安全

Windows J-Link 驱动功能在本版随未签名的 helper 与 libwdi DLL 发布。Release 工作流在一次性 Windows runner 上构建它们，生成 SHA-256 清单，并验证构建产物与 VSIX 内字节一致；helper 在提权后还会核对配套 DLL 的 SHA-256。哈希校验不能提供发布者身份认证，Windows 可能显示“未知发布者”或根据本机策略阻止运行。发布 job 只在发布阶段申请 `contents: write`，并使用 GitHub 自动提供的短期 `GITHUB_TOKEN` 创建 Release。建议保护 `v*` 标签，防止未审查的提交触发发布。

## 发布稳定版本

先将功能改动合入 `master`，并在 `CHANGELOG.md` 的 `## [Unreleased]` 下记录用户可见变化；该节必须非空。以下示例发布 `0.8.1`，执行时替换版本号与日期：

```powershell
npm run release:prepare -- 0.8.1 --date 2026-10-04
node scripts/validate-release.js v0.8.1
npm run check
npm run quality
git add -A docs package.json package-lock.json README.md README_EN.md CHANGELOG.md
git commit -m "Release EmberProbe v0.8.1"
git tag -a v0.8.1 -m "EmberProbe v0.8.1"
git push origin master
git push origin v0.8.1
gh run watch
```

`release:prepare` 同步五个版本文件，并清理 `docs/` 中未列入 `scripts/docs-cleanup.js` `MAIN_DOCS` 的 Markdown 和 JSON 文档；图片等资源全部保留。新增长期文档时加入该名单。

用 `npm run docs:clean` 预览，`npm run docs:clean -- --write` 执行；`release:prepare --no-clean-docs` 可跳过清理，`--dry-run` 不修改文件。

确认验证与质量检查通过后，提交五个版本文件及文档删除；创建标签前检查暂存区。两个 push 都须成功，再用 `gh run watch` 等待对应 Release 工作流完成。

标签必须使用 `vX.Y.Z`，或下文的预发布格式 `vX.Y.Z-alpha.N` / `-beta.N` / `-rc.N`（N 从 1 开始），并与五个文件的版本引用一致；其他后缀（如 `-preview.1`、`-beta`、`+build.1`）会被拒绝。发布时不要在本地运行 `npm run package`；CI 构建并上传正式 VSIX，本地打包仅用于开发验证。

工作流依次执行：

1. 复用 CI：Windows、Ubuntu、macOS 的 Node 20 普通检查和 bundle、Windows libwdi/helper 原生构建、Ubuntu Node 24 质量检查及 Extension Host 冒烟测试。
2. 在 Windows 构建 libwdi 与 helper，验证 WDK 二进制的 Microsoft 签名，将 libwdi 的 SHA-256 编入 helper，并生成两个未签名原生文件的 SHA-256 清单。
3. 校验标签与发布元数据，将原生文件下载到打包任务，核对 SHA-256，生成 VSIX 并核对包内字节与清单一致。
4. 创建 GitHub Draft Release 并上传已验证的 VSIX；附件上传成功后转为正式 Release。

## 发布预发布版本

预发布版本直接从 `master` 打标签，不另建长期分支。只有在预发布收尾期间 `master` 已开始下一版本功能时，才从预发布标签切出 `release/X.Y` 短期分支，修复同时合回 `master`，正式版发布后不再维护该分支。

以 `0.9.0` 为例，依次发布 `0.9.0-beta.1`、`0.9.0-beta.2`、`0.9.0-rc.1`，最后发布 `0.9.0`。每个预发布版本的步骤与稳定版本相同，只替换版本号：

```powershell
npm run release:prepare -- 0.9.0-beta.1 --date 2026-10-22
node scripts/validate-release.js v0.9.0-beta.1
npm run check
npm run quality
git add -A docs package.json package-lock.json README.md README_EN.md CHANGELOG.md
git commit -m "Release EmberProbe v0.9.0-beta.1"
git tag -a v0.9.0-beta.1 -m "EmberProbe v0.9.0-beta.1"
git push origin master
git push origin v0.9.0-beta.1
gh run watch
```

- 预发布标签同样触发 Release 工作流并执行全部门禁；GitHub Release 会标记为 Pre-release，不占用 “Latest”，稳定版用户默认看不到。
- 每个预发布版本都需要非空的 `## [Unreleased]`，`release:prepare` 会将其移入 `## [0.9.0-beta.1]` 等独立章节。
- 发布正式版 `0.9.0` 时，`release:prepare` 会把 `Unreleased` 与全部 `0.9.0-*` 章节按新到旧合并为一个 `## [0.9.0]` 章节，并删除这些预发布章节，让稳定版用户在一处看到完整变化。若 `rc` 之后没有新改动，`Unreleased` 可以为空。各预发布版本的说明仍保留在对应的 GitHub Release 中。
- 预发布版本也会更新 README 中的当前版本号；正式版发布时恢复为稳定版本号。
- 当前只通过 GitHub Release 分发 VSIX。VS Code Marketplace 不接受 `-beta.N` 这类版本号；如以后上架 Marketplace，需要改用 `vsce publish --pre-release` 与奇偶 minor 版本方案。

## 发布说明

工作流成功发布后，用 `gh release view <上一版标签>` 阅读上一版说明，将新版本的自动生成说明替换为同样简洁的双语摘要：先写中文编号章节 `新增` / `优化` / `修复`，再写英文 `Added` / `Improved` / `Fixed`，每项一行。将完整文本保存到 UTF-8 文件 `release-notes.md`，再执行：

```powershell
gh release edit v0.8.1 --notes-file "release-notes.md"
```

## 失败与重试

如果创建 Release、上传附件或公开草稿失败，在 GitHub **Actions → Release → Run workflow** 中输入原标签重跑。

也可使用 `gh workflow run release.yml --ref master -f tag=v0.8.1` 重试，再用 `gh run watch` 选择新触发的运行。执行时替换为原发布标签。

重试从 `master` 加载发布及复用 CI 工作流，但检查、构建和打包仍检出指定标签。这样可以修正 CI 环境后重试同一份源代码，无需改变标签；功能代码修复应使用新版本发布。Windows 检查先规范化临时目录，避免 runner 的 8.3 短路径与实际文件身份不一致。

工作流可安全处理常见重试场景：

- Draft Release 已存在时会复用并更新 VSIX。
- GitHub Release 已经公开时会直接结束，不重复发布。

如维护者明确要求同版本修复图标等打包问题，可从包含修复的 `master` 提交执行：

```powershell
gh workflow run release.yml --ref master -f tag=v0.8.4 -F rebuild=true
```

`rebuild` 默认关闭。显式开启后，检查、原生构建、打包和上传使用本次工作流的同一个提交 SHA，仍校验五个文件与目标版本一致；通过全部门禁后替换该版本的 VSIX 附件，保留发布说明和公开状态。标签保持原有指向。发布说明应记录打包修复、构建提交与对应运行，以说明附件来源；功能代码变化仍使用新版本。

不要删除已经发布的标签后用同一版本指向其他提交；除明确授权的打包修复外，发布构件应保持不可变。
