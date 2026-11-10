use std::collections::{HashMap, VecDeque};
use std::io;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

const READY_PER_SIZE: usize = 10;
const SIZES_KEPT: usize = 8;
const SMALLEST_CLASS: usize = 64 * 1024;

pub(super) struct ShmPool {
    ready: Arc<Mutex<HashMap<usize, VecDeque<Region>>>>,
    wanted: Sender<usize>,
}

pub(super) struct Region {
    pub name: String,
    ptr: usize,
    len: usize,
    _fd: rustix::fd::OwnedFd,
}

impl Region {
    #[allow(unsafe_code)]
    pub fn bytes(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.ptr as *mut u8, self.len) }
    }
}

impl Drop for Region {
    #[allow(unsafe_code)]
    fn drop(&mut self) {
        unsafe {
            let _ = rustix::mm::munmap(self.ptr as *mut std::ffi::c_void, self.len);
        }
    }
}

impl ShmPool {
    pub(super) fn new(prefix: String) -> Self {
        let ready = Arc::new(Mutex::new(HashMap::new()));
        let (wanted, requests) = channel();
        let filled = ready.clone();
        std::thread::Builder::new().name("shm-pool".into()).spawn(move || refill(prefix, requests, filled)).ok();
        Self { ready, wanted }
    }

    pub(super) fn has_ready(&self, len: usize) -> bool {
        let class = len.next_power_of_two().max(SMALLEST_CLASS);
        self.ready.lock().ok().is_some_and(|ready| ready.get(&class).is_some_and(|r| !r.is_empty()))
    }

    pub(super) fn take(&self, len: usize) -> Option<Region> {
        let class = len.next_power_of_two().max(SMALLEST_CLASS);
        let region = self.ready.lock().ok()?.get_mut(&class).and_then(VecDeque::pop_front);
        let _ = self.wanted.send(class);
        region
    }
}

impl Drop for ShmPool {
    fn drop(&mut self) {
        if let Ok(mut ready) = self.ready.lock() {
            for region in ready.drain().flat_map(|(_, regions)| regions) {
                let _ = rustix::shm::unlink(&region.name);
            }
        }
    }
}

fn refill(prefix: String, requests: Receiver<usize>, ready: Arc<Mutex<HashMap<usize, VecDeque<Region>>>>) {
    let mut seq = 0u64;
    let mut recent: VecDeque<usize> = VecDeque::new();
    while let Ok(len) = requests.recv() {
        recent.retain(|&l| l != len);
        recent.push_back(len);
        if recent.len() > SIZES_KEPT {
            let dropped = recent.pop_front();
            if let (Some(dropped), Ok(mut ready)) = (dropped, ready.lock()) {
                for region in ready.remove(&dropped).into_iter().flatten() {
                    let _ = rustix::shm::unlink(&region.name);
                }
            }
        }
        loop {
            let have = ready.lock().map(|r| r.get(&len).map_or(0, VecDeque::len)).unwrap_or(READY_PER_SIZE);
            if have >= READY_PER_SIZE {
                break;
            }
            seq += 1;
            let Ok(region) = create(&format!("{prefix}-p{seq}"), len) else { break };
            match ready.lock() {
                Ok(mut ready) => ready.entry(len).or_default().push_back(region),
                Err(_) => return,
            }
        }
    }
}

#[allow(unsafe_code)]
fn create(name: &str, len: usize) -> io::Result<Region> {
    let fd = rustix::shm::open(
        name,
        rustix::shm::OFlags::CREATE | rustix::shm::OFlags::EXCL | rustix::shm::OFlags::RDWR,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )?;
    rustix::fs::ftruncate(&fd, len as u64)?;
    let ptr = unsafe {
        rustix::mm::mmap(std::ptr::null_mut(), len, rustix::mm::ProtFlags::READ | rustix::mm::ProtFlags::WRITE, rustix::mm::MapFlags::SHARED, &fd, 0)?
    };
    let mut region = Region { name: name.to_string(), ptr: ptr as usize, len, _fd: fd };
    for page in region.bytes().chunks_mut(4096) {
        page[0] = 0;
    }
    Ok(region)
}
