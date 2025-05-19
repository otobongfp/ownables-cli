use crate::error::ContractError;
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
#[cfg(not(feature = "library"))]
use cosmwasm_std::{Addr, Deps, DepsMut, Env, MessageInfo, Response, StdResult};
use cosmwasm_std::{Binary, to_json_binary};
use cw2::set_contract_version;
use crate::state::{NFT_ITEM, CONFIG, METADATA, LOCKED, PACKAGE_CID, OWNABLE_INFO, NETWORK_ID};
use ownable_std::{address_eip155, address_lto, ExternalEventMsg, InfoResponse, Metadata, OwnableInfo};
use ownables_std::{Metadata, OwnableType};

// version info for migration info
const CONTRACT_NAME: &str = PLACEHOLDER4_CONTRACT_NAME;
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let derived_addr = address_lto(
        msg.network_id as char,
        info.sender.to_string()
    )?;

    let ownable_info = OwnableInfo {
        owner: derived_addr.clone(),
        issuer: derived_addr.clone(),
        ownable_type: Some(PLACEHOLDER4_TYPE.to_string()),
    };

    let metadata = Metadata {
        image: None,
        image_data: None,
        external_url: None,
        description: Some(PLACEHOLDER4_DESCRIPTION.to_string()),
        name: Some(PLACEHOLDER4_NAME.to_string()),
        background_color: None,
        animation_url: None,
        youtube_url: None
    };

    NETWORK_ID.save(deps.storage, &msg.network_id)?;
    CONFIG.save(deps.storage, &None)?;
    if let Some(nft) = msg.nft {
        NFT_ITEM.save(deps.storage, &nft)?;
    }
    METADATA.save(deps.storage, &metadata)?;
    LOCKED.save(deps.storage, &false)?;
    OWNABLE_INFO.save(deps.storage, &ownable_info)?;
    PACKAGE_CID.save(deps.storage, &msg.package)?;

    let state = State {
        name: msg.name,
        description: msg.description,
        owner: info.sender,
        locked: false,
        ownable_type: OwnableType::Music,
    };

    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("method", "instantiate")
        .add_attribute("owner", derived_addr.clone())
        .add_attribute("issuer", derived_addr.clone()))
}

pub fn execute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Transfer { recipient } => {
            let mut state = STATE.load(deps.storage)?;
            if info.sender != state.owner {
                return Err(ContractError::Unauthorized {});
            }
            if state.locked {
                return Err(ContractError::Locked {});
            }
            state.owner = recipient;
            STATE.save(deps.storage, &state)?;
            Ok(Response::new()
                .add_attribute("method", "transfer")
                .add_attribute("new_owner", state.owner))
        }
        ExecuteMsg::Lock {} => {
            let mut state = STATE.load(deps.storage)?;
            if info.sender != state.owner {
                return Err(ContractError::Unauthorized {});
            }
            state.locked = true;
            STATE.save(deps.storage, &state)?;
            Ok(Response::new().add_attribute("method", "lock"))
        }
    }
}

pub fn register_external_event(
    info: MessageInfo,
    deps: DepsMut,
    event: ExternalEventMsg,
    _ownable_id: String,
) -> Result<Response, ContractError> {
    let mut response = Response::new()
        .add_attribute("method", "register_external_event");

    match event.event_type.as_str() {
        "lock" => {
            try_register_lock(
                info,
                deps,
                event,
            )?;
            response = response.add_attribute("event_type", "lock");
        },
        _ => return Err(ContractError::MatchEventError { val: event.event_type }),
    };

    Ok(response)
}

fn try_release(_info: MessageInfo, deps: DepsMut, to: Addr) -> Result<Response, ContractError> {
    let mut is_locked = LOCKED.load(deps.storage)?;
    if !is_locked {
        return Err(ContractError::LockError { val: "Not locked".to_string() });
    }

    // transfer ownership and unlock
    let mut ownership = OWNABLE_INFO.load(deps.storage)?;
    ownership.owner = to;
    is_locked = false;

    OWNABLE_INFO.save(deps.storage, &ownership)?;
    LOCKED.save(deps.storage, &is_locked)?;

    Ok(Response::new()
        .add_attribute("method", "try_release")
        .add_attribute("is_locked", is_locked.to_string())
        .add_attribute("owner", ownership.owner.to_string())
    )
}

fn try_register_lock(
    info: MessageInfo,
    deps: DepsMut,
    event: ExternalEventMsg,
) -> Result<Response, ContractError> {
    let owner = event.attributes.get("owner")
        .cloned()
        .unwrap_or_default();
    let nft_id = event.attributes.get("token_id")
        .cloned()
        .unwrap_or_default();
    let contract_addr = event.attributes.get("contract")
        .cloned()
        .unwrap_or_default();

    if owner.is_empty() || nft_id.is_empty() || contract_addr.is_empty() {
        return Err(ContractError::InvalidExternalEventArgs {});
    }

    let nft = NFT_ITEM.load(deps.storage).unwrap();
    if nft.id.to_string() != nft_id {
        return Err(ContractError::LockError {
            val: "nft_id mismatch".to_string()
        });
    } else if nft.address != contract_addr {
        return Err(ContractError::LockError {
            val: "locking contract mismatch".to_string()
        });
    }

    let event_network = event.network.unwrap_or("".to_string());
    if event_network == "" {
        return Err(ContractError::MatchChainIdError { val: "No network".to_string() })
    } else if event_network != nft.network {
        return Err(ContractError::LockError {
            val: "network mismatch".to_string()
        });
    }

    let caip_2_fields: Vec<&str> = event_network.split(":").collect();
    let namespace = caip_2_fields.get(0).unwrap();

    match *namespace {
        "eip155" => {
            // assert that owner address is the eip155 of info.sender pk
            let address = address_eip155(info.sender.to_string())?;
            if address != address_eip155(owner.clone())? {
                return Err(ContractError::Unauthorized {
                    val: "Only the owner can release an ownable".to_string(),
                });
            }

            let network_id = NETWORK_ID.load(deps.storage)?;
            let address = address_lto(network_id as char, owner)?;
            Ok(try_release(info, deps, address)?)
        }
        _ => return Err(ContractError::MatchChainIdError { val: event_network }),
    }
}

pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetInfo {} => to_binary(&query_info(deps)?),
        QueryMsg::IsLocked {} => to_binary(&query_locked(deps)?),
        QueryMsg::GetMetadata {} => to_binary(&query_metadata(deps)?),
        QueryMsg::GetWidgetState {} => to_binary(&query_widget_state(deps)?),
    }
}

fn query_info(deps: Deps) -> StdResult<InfoResponse> {
    let state = STATE.load(deps.storage)?;
    Ok(InfoResponse {
        name: state.name,
        description: state.description,
        ownable_type: state.ownable_type,
    })
}

fn query_locked(deps: Deps) -> StdResult<bool> {
    let state = STATE.load(deps.storage)?;
    Ok(state.locked)
}

fn query_metadata(deps: Deps) -> StdResult<MetadataResponse> {
    let state = STATE.load(deps.storage)?;
    Ok(MetadataResponse {
        metadata: Metadata {
            name: state.name,
            description: state.description,
            ownable_type: state.ownable_type,
        },
    })
}

fn query_widget_state(deps: Deps) -> StdResult<WidgetStateResponse> {
    let state = STATE.load(deps.storage)?;
    Ok(WidgetStateResponse {
        state: format!(
            r#"{{"name":"{}","description":"{}","type":"music"}}"#,
            state.name, state.description
        ),
    })
}

