# Template for Casks/claude-accounts.rb in the NurFajarSA/homebrew-tap repository.
# Run scripts/update-cask.sh <version> after packaging to fill in version and sha256.
cask "claude-accounts" do
  version "1.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/NurFajarSA/claude-switch/releases/download/v#{version}/ClaudeAccounts-#{version}-macos-arm64.zip"
  name "Claude Accounts"
  desc "Menu bar app and cs CLI to use several Claude accounts on one Mac"
  homepage "https://github.com/NurFajarSA/claude-switch"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :sequoia"
  depends_on arch: :arm64

  app "Claude Accounts.app"
  binary "#{appdir}/Claude Accounts.app/Contents/Resources/cs"

  zap trash: "~/.config/claude-switch"
end
