use cosmwasm_std::{Addr};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ownable_std_macros::{
    ownables_transfer, ownables_lock,
    ownables_query_info, ownables_query_locked, ownables_query_metadata,
    ownables_query_widget_state, ownables_instantiate_msg
};
use ownable_std::NFT;
use ownables_std::{Metadata, OwnableType};

#[ownables_instantiate_msg]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub struct InstantiateMsg {}

#[ownables_transfer]
#[ownables_lock]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecuteMsg {
    Transfer { recipient: Addr },
    Lock {},
}

#[ownables_query_info]
#[ownables_query_locked]
#[ownables_query_metadata]
#[ownables_query_widget_state]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryMsg {
    GetInfo {},
    IsLocked {},
    GetMetadata {},
    GetWidgetState {},
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct InfoResponse {
    pub name: String,
    pub description: String,
    pub ownable_type: OwnableType,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct MetadataResponse {
    pub metadata: Metadata,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct WidgetStateResponse {
    pub state: String,
}

