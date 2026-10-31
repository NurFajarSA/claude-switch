# Template for Casks/accounts-manager-for-claude.rb in the NurFajarSA/homebrew-tap repository.
# Run scripts/update-cask.sh <version> after packaging to fill in version and sha256.
cask "accounts-manager-for-claude" do
  version "1.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/NurFajarSA/claude-switch/releases/download/v#{version}/AccountsManager-#{version}-macos-arm64.zip"
  name "Accounts Manager for Claude"
  desc "Menu bar app and cs CLI to use several Claude accounts on one Mac"
  homepage "https://github.com/NurFajarSA/claude-switch"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :sequoia"
  depends_on arch: :arm64

  app "Accounts Manager for Claude.app"
  binary "#{appdir}/Accounts Manager for Claude.app/Contents/Resources/cs"

  zap trash: "~/.config/claude-switch"
end
