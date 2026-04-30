# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git 運用ルール

- コードを変更するたびに、必ずGitHubにプッシュすること。
- コミットメッセージは変更内容を簡潔に日本語で記述する。
- `main` ブランチへの直接プッシュを基本とするが、大きな変更はフィーチャーブランチを切ってPRを作成する。

### 変更時の手順

```bash
git add <変更ファイル>
git commit -m "変更内容の説明"
git push origin main
```
