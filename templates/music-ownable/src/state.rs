use cosmwasm_std::Addr;
use cw_storage_plus::Item;
use ownables_std::OwnableType;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ownable_std::{Metadata, NFT, OwnableInfo};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct State {
    pub name: String,
    pub description: String,
    pub owner: Addr,
    pub locked: bool,
    pub ownable_type: OwnableType,
}

pub const STATE: Item<State> = Item::new("state");

pub const CONFIG: Item<Option<Config>> = Item::new("config");
pub const OWNABLE_INFO: Item<OwnableInfo> = Item::new("ownable_info");
pub const METADATA: Item<Metadata> = Item::new("metadata");
pub const NFT_ITEM: Item<NFT> = Item::new("nft");
pub const LOCKED: Item<bool> = Item::new("is_locked");
pub const PACKAGE_CID: Item<String> = Item::new("package_cid");
pub const NETWORK_ID: Item<u8> = Item::new("network_id");
