#!/bin/bash

# ========================================
# Instagram Story Automation - Setup Script
# ========================================
# このスクリプトは初回セットアップを自動化します
#
# 使用方法：
#   bash setup.sh
# ========================================

set -e  # エラーで停止

# カラー出力
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}Instagram Story Auto-Posting${NC}"
echo -e "${BLUE}Setup Script${NC}"
echo -e "${BLUE}================================${NC}\n"

# ========================================
# 前提条件チェック
# ========================================

echo -e "${YELLOW}[1/5] チェック：前提条件...${NC}"

# Node.js チェック
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js がインストールされていません${NC}"
    echo "   https://nodejs.org から Node.js 18+ をインストールしてください"
    exit 1
fi

NODE_VERSION=$(node --version)
echo -e "${GREEN}✅ Node.js ${NODE_VERSION} 確認${NC}"

# npm チェック
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm がインストールされていません${NC}"
    exit 1
fi

NPM_VERSION=$(npm --version)
echo -e "${GREEN}✅ npm ${NPM_VERSION} 確認${NC}\n"

# ========================================
# 環境変数ファイル設定
# ========================================

echo -e "${YELLOW}[2/5] セットアップ：環境変数...${NC}"

if [ -f ".env" ]; then
    echo -e "${YELLOW}⚠️  .env ファイルが既に存在します${NC}"
    read -p "上書きしますか？ (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${GREEN}✅ .env をスキップ${NC}\n"
        ENV_READY=true
    fi
fi

if [ ! "$ENV_READY" == "true" ]; then
    cp .env.example .env
    chmod 600 .env
    echo -e "${YELLOW}📝 .env ファイルを作成しました${NC}"
    echo -e "${YELLOW}   以下の値を編集してください：${NC}"
    echo -e "   ${BLUE}nano .env${NC}"
    echo
    read -p "編集完了したら Enter キーを押してください..."
    echo -e "${GREEN}✅ .env ファイル設定完了${NC}\n"
fi

# ========================================
# 依存パッケージインストール
# ========================================

echo -e "${YELLOW}[3/5] インストール：依存パッケージ...${NC}"

if [ -d "node_modules" ]; then
    echo -e "${YELLOW}⚠️  node_modules フォルダが既に存在します${NC}"
    read -p "再インストールしますか？ (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${GREEN}✅ パッケージインストールをスキップ${NC}\n"
    else
        npm install
        echo -e "${GREEN}✅ パッケージをインストール${NC}\n"
    fi
else
    npm install
    echo -e "${GREEN}✅ パッケージをインストール${NC}\n"
fi

# ========================================
# 環境変数バリデーション
# ========================================

echo -e "${YELLOW}[4/5] チェック：環境変数の値...${NC}"

# .env から値を読み込み
export $(cat .env | grep -v '^#' | xargs)

REQUIRED_VARS=(
    "GOOGLE_SHEET_ID"
    "WORDPRESS_URL"
    "WORDPRESS_USERNAME"
    "WORDPRESS_APP_PASSWORD"
    "INSTAGRAM_BUSINESS_ACCOUNT_ID"
    "INSTAGRAM_ACCESS_TOKEN"
    "FACEBOOK_PAGE_ID"
)

MISSING_VARS=()

for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ] || [ "${!var}" == "xxxx xxxx xxxx xxxx xxxx xxxx" ]; then
        MISSING_VARS+=("$var")
    fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    echo -e "${RED}❌ 未設定の環境変数：${NC}"
    for var in "${MISSING_VARS[@]}"; do
        echo -e "   ${RED}・ $var${NC}"
    done
    echo
    echo -e "${YELLOW}❓ .env ファイルを編集して、すべての値を設定してください${NC}"
    echo -e "   ${BLUE}nano .env${NC}"
    exit 1
fi

echo -e "${GREEN}✅ 環境変数をチェック${NC}\n"

# ========================================
# テスト実行
# ========================================

echo -e "${YELLOW}[5/5] テスト：画像生成...${NC}"

echo -e "${YELLOW}⏳ テスト実行中（この処理には 10～30秒かかります）...${NC}"

if npm run test > /dev/null 2>&1; then
    echo -e "${GREEN}✅ テスト実行成功${NC}"
    
    if [ -d "output" ] && [ -n "$(ls -A output 2>/dev/null)" ]; then
        echo -e "${GREEN}✅ 画像生成確認（output/ フォルダ）${NC}"
    fi
else
    echo -e "${RED}❌ テスト実行失敗${NC}"
    echo -e "${YELLOW}   詳細は以下を実行して確認してください：${NC}"
    echo -e "   ${BLUE}npm run test${NC}"
fi

echo

# ========================================
# セットアップ完了
# ========================================

echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}✅ セットアップ完了！${NC}"
echo -e "${GREEN}================================${NC}\n"

echo -e "${YELLOW}次のステップ：${NC}"
echo
echo "1️⃣  ローカルテスト（完全実行）"
echo -e "   ${BLUE}npm run full${NC}"
echo
echo "2️⃣  GitHub Actions 設定"
echo -e "   - リポジトリを GitHub にプッシュ"
echo -e "   - Settings > Secrets に環境変数を登録"
echo -e "   - .github/workflows/instagram-story-daily.yml を配置"
echo
echo "3️⃣  毎日 0:00 JST に自動実行開始"
echo
echo -e "${YELLOW}詳細は ${BLUE}README-ja.md${YELLOW} を参照してください${NC}\n"
