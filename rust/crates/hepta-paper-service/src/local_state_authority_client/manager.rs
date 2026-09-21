//! One completed system-manager observation, never a live installation proof.
//! Run before opening any SQLite connection: D-Bus receives and drops FDs.
use super::*;
use nix::sys::socket::{getsockopt, sockopt};
use std::{
    fs::File,
    os::{fd::BorrowedFd, unix::fs::FileExt},
};
use zbus::{
    Connection, Message,
    connection::{AuthMechanism, Builder},
    zvariant::{Fd, OwnedObjectPath, OwnedValue},
};

#[cfg(test)]
mod tests;
mod wire;

const BUS_PATH: &str = "/run/dbus/system_bus_socket";
const BUS_NAME: &str = "org.freedesktop.DBus";
const BUS_OBJECT: &str = "/org/freedesktop/DBus";
const MANAGER_NAME: &str = "org.freedesktop.systemd1";
const MANAGER_OBJECT: &str = "/org/freedesktop/systemd1";
const UNIT_INTERFACE: &str = "org.freedesktop.systemd1.Unit";
const MAXIMUM_OBSERVATION_MS: u64 = 5_000;
const MAXIMUM_REPLY_BYTES: usize = 64 * 1024;

/// Actual facts observed from the authenticated system bus and the original
/// socket peer pidfd. All bus resources have been destroyed before this value
/// is returned. No installation match, continued currentness, native provenance
/// or authorization is implied. No deserialization or caller-data constructor.
#[derive(Debug)]
pub struct ObservedSocketPeerManagerAssociationV1 {
    report: Value,
}
impl ObservedSocketPeerManagerAssociationV1 {
    pub fn report(&self) -> &Value {
        &self.report
    }
}

struct BootObservation {
    file: File,
    identity: String,
}
impl BootObservation {
    fn load() -> Result<Self> {
        let file = File::open("/proc/sys/kernel/random/boot_id")
            .map_err(|_| fail("local_state_authority_manager_boot_unavailable"))?;
        let identity = Self::read(&file)?;
        Ok(Self { file, identity })
    }
    fn read(file: &File) -> Result<String> {
        let mut bytes = [0_u8; 64];
        let read = file
            .read_at(&mut bytes, 0)
            .map_err(|_| fail("local_state_authority_manager_boot_unavailable"))?;
        if read != 37
            || bytes[36] != b'\n'
            || !bytes[..36].iter().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    *byte == b'-'
                } else {
                    byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
                }
            })
        {
            return Err(fail("local_state_authority_manager_boot_unavailable"));
        }
        String::from_utf8(bytes[..36].to_vec())
            .map_err(|_| fail("local_state_authority_manager_boot_unavailable"))
    }
    fn assert_current(&self) -> Result<()> {
        if Self::read(&self.file)? != self.identity {
            return Err(fail("local_state_authority_manager_boot_changed"));
        }
        Ok(())
    }
}

pub(super) fn observe(
    origin: &peer::SocketPeer,
    timeout_ms: u64,
) -> Result<ObservedSocketPeerManagerAssociationV1> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.min(MAXIMUM_OBSERVATION_MS));
    origin.assert_alive(deadline)?;
    let boot = BootObservation::load()?;
    let options = LocalStateAuthorityClientOptionsV1 {
        socket_path: BUS_PATH.into(),
        timeout_ms,
        maximum_message_bytes: MAXIMUM_REPLY_BYTES,
    };
    // Use the literal pathname, never DBUS_SYSTEM_BUS_ADDRESS or a session bus.
    let stream = open_socket(&options, deadline)?;
    let bus_credentials = getsockopt(&stream, sockopt::PeerCredentials)
        .map_err(|_| fail("local_state_authority_manager_bus_peer_invalid"))?;
    if bus_credentials.uid() != 0 || bus_credentials.pid() <= 0 {
        return Err(fail("local_state_authority_manager_bus_peer_invalid"));
    }
    let facts = exchange_manager(stream, origin.origin_pidfd(), deadline)?;
    boot.assert_current()?;
    origin.assert_alive(deadline)?;
    let (pid, uid, gid) = origin.origin_credentials();
    Ok(ObservedSocketPeerManagerAssociationV1 {
        report: json!({
            "version": 1,
            "kind": "HeptaSocketPeerSystemManagerObservationV1",
            "evidenceScope": "static_socket_origin_manager_observation_no_installation_or_activation_authority",
            "socketOrigin": {"pid":pid,"uid":uid,"gid":gid},
            "bootId":boot.identity,
            "busPeer": {"pid":bus_credentials.pid(),"uid":bus_credentials.uid(),"gid":bus_credentials.gid()},
        "manager":facts,
        "propertyObservation":"individual_reads_bracketed_by_peer_association_not_atomic",
            "busClosedBeforeReturn":true,
            "maximumObservationMs":MAXIMUM_OBSERVATION_MS,
            "maximumReceivedBytes":wire::MAXIMUM_RECEIVED_BYTES,
            "maximumReplyBytes":MAXIMUM_REPLY_BYTES,
            "protocolMaximumFrameBytes":128 * 1024 * 1024,
        }),
    })
}

async fn bounded<T>(
    deadline: Instant,
    future: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    deadline_current(deadline)?;
    let result = futures_lite::future::race(future, async {
        async_io::Timer::at(deadline).await;
        Err(fail("local_state_authority_manager_timeout"))
    })
    .await?;
    deadline_current(deadline)?;
    Ok(result)
}

fn exchange_manager(stream: UnixStream, pidfd: BorrowedFd<'_>, deadline: Instant) -> Result<Value> {
    let (socket, closed) = wire::BoundedSocket::new(stream, deadline)
        .map_err(|_| fail("local_state_authority_manager_connection_failed"))?;
    let result = async_io::block_on(async {
        let connection = bounded(deadline, async {
            Builder::socket(socket)
                .auth_mechanism(AuthMechanism::External)
                .internal_executor(false)
                .max_queued(1)
                .build()
                .await
                .map_err(|_| fail("local_state_authority_manager_connection_failed"))
        })
        .await?;
        let executor = connection.executor().clone();
        // No detached/background executor survives this lexical scope.
        let outcome = futures_lite::future::race(
            async {
                loop {
                    executor.tick().await;
                }
            },
            async {
                let outcome = bounded(deadline, protocol(&connection, pidfd, deadline)).await;
                closed.shutdown();
                let close = bounded(deadline, async {
                    connection
                        .close()
                        .await
                        .map_err(|_| fail("local_state_authority_manager_close_failed"))
                })
                .await;
                match outcome {
                    Ok(value) => {
                        close?;
                        Ok(value)
                    }
                    Err(error) => Err(error),
                }
            },
        )
        .await;
        drop(executor);
        outcome
    });
    if !closed.is_closed() {
        return Err(fail("local_state_authority_manager_reader_not_destroyed"));
    }
    result
}

async fn call<B: serde::Serialize + zbus::zvariant::DynamicType>(
    connection: &Connection,
    destination: &str,
    path: &str,
    interface: &str,
    method: &str,
    body: &B,
    deadline: Instant,
) -> Result<Message> {
    bounded(deadline, async {
        let message = connection
            .call_method(Some(destination), path, Some(interface), method, body)
            .await
            .map_err(|_| fail("local_state_authority_manager_rpc_failed"))?;
        validate_reply(&message, destination)?;
        Ok(message)
    })
    .await
}

fn validate_reply(message: &Message, destination: &str) -> Result<()> {
    if message.message_type() != zbus::message::Type::MethodReturn
        || message.header().sender().map(|value| value.as_str()) != Some(destination)
        || message.data().len() > MAXIMUM_REPLY_BYTES
        || !message.data().fds().is_empty()
    {
        return Err(fail("local_state_authority_manager_reply_invalid"));
    }
    Ok(())
}

async fn owner(connection: &Connection, deadline: Instant) -> Result<String> {
    let message = call(
        connection,
        BUS_NAME,
        BUS_OBJECT,
        BUS_NAME,
        "GetNameOwner",
        &(MANAGER_NAME,),
        deadline,
    )
    .await?;
    let name: String = message
        .body()
        .deserialize()
        .map_err(|_| fail("local_state_authority_manager_reply_invalid"))?;
    zbus::names::UniqueName::try_from(name.as_str())
        .map_err(|_| fail("local_state_authority_manager_reply_invalid"))?;
    Ok(name)
}

async fn principal(connection: &Connection, owner: &str, deadline: Instant) -> Result<()> {
    for (method, expected) in [
        ("GetConnectionUnixUser", 0_u32),
        ("GetConnectionUnixProcessID", 1_u32),
    ] {
        let message = call(
            connection,
            BUS_NAME,
            BUS_OBJECT,
            BUS_NAME,
            method,
            &(owner,),
            deadline,
        )
        .await?;
        let actual: u32 = message
            .body()
            .deserialize()
            .map_err(|_| fail("local_state_authority_manager_reply_invalid"))?;
        if actual != expected {
            return Err(fail("local_state_authority_manager_owner_invalid"));
        }
    }
    Ok(())
}

#[derive(Debug, Eq, PartialEq)]
struct Association {
    path: OwnedObjectPath,
    unit: String,
    invocation: Vec<u8>,
}
async fn association(
    connection: &Connection,
    owner: &str,
    pidfd: BorrowedFd<'_>,
    deadline: Instant,
) -> Result<Association> {
    let message = call(
        connection,
        owner,
        MANAGER_OBJECT,
        "org.freedesktop.systemd1.Manager",
        "GetUnitByPIDFD",
        &(Fd::Borrowed(pidfd),),
        deadline,
    )
    .await?;
    let (path, unit, invocation): (OwnedObjectPath, String, Vec<u8>) = message
        .body()
        .deserialize()
        .map_err(|_| fail("local_state_authority_manager_reply_invalid"))?;
    if path.as_str().len() > 4096
        || unit.is_empty()
        || unit.len() > 255
        || invocation.len() != 16
        || invocation.iter().all(|byte| *byte == 0)
    {
        return Err(fail("local_state_authority_manager_reply_invalid"));
    }
    Ok(Association {
        path,
        unit,
        invocation,
    })
}

async fn property<T: TryFrom<OwnedValue>>(
    connection: &Connection,
    owner: &str,
    path: &str,
    interface: &str,
    property: &str,
    deadline: Instant,
) -> Result<T> {
    let message = call(
        connection,
        owner,
        path,
        "org.freedesktop.DBus.Properties",
        "Get",
        &(interface, property),
        deadline,
    )
    .await?;
    let value: OwnedValue = message
        .body()
        .deserialize()
        .map_err(|_| fail("local_state_authority_manager_reply_invalid"))?;
    T::try_from(value).map_err(|_| fail("local_state_authority_manager_reply_invalid"))
}

async fn protocol(
    connection: &Connection,
    pidfd: BorrowedFd<'_>,
    deadline: Instant,
) -> Result<Value> {
    let original_owner = owner(connection, deadline).await?;
    principal(connection, &original_owner, deadline).await?;
    let original = association(connection, &original_owner, pidfd, deadline).await?;
    let mut properties = serde_json::Map::new();
    for name in ["Id", "LoadState", "ActiveState", "SubState", "FragmentPath"] {
        let value: String = property(
            connection,
            &original_owner,
            original.path.as_str(),
            UNIT_INTERFACE,
            name,
            deadline,
        )
        .await?;
        if value.len() > 4096 {
            return Err(fail("local_state_authority_manager_reply_invalid"));
        }
        properties.insert(name.into(), json!(value));
    }
    let reload: bool = property(
        connection,
        &original_owner,
        original.path.as_str(),
        UNIT_INTERFACE,
        "NeedDaemonReload",
        deadline,
    )
    .await?;
    let invocation: Vec<u8> = property(
        connection,
        &original_owner,
        original.path.as_str(),
        UNIT_INTERFACE,
        "InvocationID",
        deadline,
    )
    .await?;
    let dropins: Vec<String> = property(
        connection,
        &original_owner,
        original.path.as_str(),
        UNIT_INTERFACE,
        "DropInPaths",
        deadline,
    )
    .await?;
    if dropins.len() > 64
        || dropins.iter().any(|path| path.len() > 4096)
        || invocation != original.invocation
        || properties.get("Id") != Some(&json!(original.unit))
    {
        return Err(fail("local_state_authority_manager_observation_changed"));
    }
    properties.insert("NeedDaemonReload".into(), json!(reload));
    properties.insert("DropInPaths".into(), json!(dropins));
    properties.insert("InvocationID".into(), json!(hex::encode(&invocation)));
    let mut service = serde_json::Map::new();
    // ControlGroup is exposed by each concrete cgroup-bearing unit interface,
    // not org.freedesktop.systemd1.Unit. This observation profile covers the
    // service/scope associations used for running processes.
    let group_interface = if original.unit.ends_with(".service") {
        "org.freedesktop.systemd1.Service"
    } else if original.unit.ends_with(".scope") {
        "org.freedesktop.systemd1.Scope"
    } else {
        return Err(fail("local_state_authority_manager_unit_type_unsupported"));
    };
    let control_group: String = property(
        connection,
        &original_owner,
        original.path.as_str(),
        group_interface,
        "ControlGroup",
        deadline,
    )
    .await?;
    if control_group.len() > 4096 {
        return Err(fail("local_state_authority_manager_reply_invalid"));
    }
    properties.insert("ControlGroup".into(), json!(control_group));
    if original.unit.ends_with(".service") {
        for name in ["MainPID", "ControlPID", "UID", "GID"] {
            let value: u32 = property(
                connection,
                &original_owner,
                original.path.as_str(),
                "org.freedesktop.systemd1.Service",
                name,
                deadline,
            )
            .await?;
            service.insert(name.into(), json!(value));
        }
        for name in ["Type", "User", "Group"] {
            let value: String = property(
                connection,
                &original_owner,
                original.path.as_str(),
                "org.freedesktop.systemd1.Service",
                name,
                deadline,
            )
            .await?;
            if value.len() > 4096 {
                return Err(fail("local_state_authority_manager_reply_invalid"));
            }
            service.insert(name.into(), json!(value));
        }
        let dynamic: bool = property(
            connection,
            &original_owner,
            original.path.as_str(),
            "org.freedesktop.systemd1.Service",
            "DynamicUser",
            deadline,
        )
        .await?;
        let supplementary: Vec<String> = property(
            connection,
            &original_owner,
            original.path.as_str(),
            "org.freedesktop.systemd1.Service",
            "SupplementaryGroups",
            deadline,
        )
        .await?;
        type ExecStart = (String, Vec<String>, bool, u64, u64, u64, u64, u32, i32, i32);
        let commands: Vec<ExecStart> = property(
            connection,
            &original_owner,
            original.path.as_str(),
            "org.freedesktop.systemd1.Service",
            "ExecStart",
            deadline,
        )
        .await?;
        if supplementary.len() > 32
            || supplementary.iter().any(|name| name.len() > 4096)
            || commands.len() > 32
            || commands.iter().any(|command| {
                command.0.len() > 4096
                    || command.1.len() > 128
                    || command.1.iter().any(|arg| arg.len() > 4096)
            })
        {
            return Err(fail("local_state_authority_manager_reply_invalid"));
        }
        service.insert("DynamicUser".into(), json!(dynamic));
        service.insert("SupplementaryGroups".into(), json!(supplementary));
        service.insert("ExecStart".into(), json!(commands));
    }
    let terminal = association(connection, &original_owner, pidfd, deadline).await?;
    principal(connection, &original_owner, deadline).await?;
    if original != terminal || owner(connection, deadline).await? != original_owner {
        return Err(fail("local_state_authority_manager_observation_changed"));
    }
    Ok(
        json!({"uniqueOwner":original_owner,"ownerUid":0,"ownerPid":1,
        "busGuid":connection.server_guid().as_str(),"unitPath":original.path.as_str(),
        "unitId":original.unit,"invocationId":hex::encode(original.invocation),
        "unitProperties":properties,"serviceProperties":service}),
    )
}
