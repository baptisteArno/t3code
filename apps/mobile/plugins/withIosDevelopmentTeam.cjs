const { withXcodeProject } = require("expo/config-plugins");

// Expo sets the team only on its own targets. Automatic signing assigns an extension's App Group
// only when the project names its team; a command-line DEVELOPMENT_TEAM leaves the group empty.
module.exports = function withIosDevelopmentTeam(config, teamId) {
  return withXcodeProject(config, (modConfig) => {
    for (const configuration of Object.values(
      modConfig.modResults.pbxXCBuildConfigurationSection(),
    )) {
      if (configuration?.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER) {
        configuration.buildSettings.DEVELOPMENT_TEAM = teamId;
      }
    }
    return modConfig;
  });
};
