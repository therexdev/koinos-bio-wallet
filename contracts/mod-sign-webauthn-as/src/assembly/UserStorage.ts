import { Storage, System } from "@koinos/sdk-as";
import { common } from "@koinosbox/contracts";

export default class UserStorage {
  counter: Storage.Obj<common.uint32>;
  storage: Storage.Map<Uint8Array, common.uint32>;
  user_space_id_start: u32;

  constructor(user_map_space_id: u32, counter_space_id: u32, user_space_id_start: u32) {
    const contract_id = System.getContractId();

    this.user_space_id_start = user_space_id_start;
    
    // Initialize counter storage object
    this.counter = new Storage.Obj(
      contract_id,
      counter_space_id,
      common.uint32.decode,
      common.uint32.encode,
      () => new common.uint32(0)
    );

    // Initialize storage map for user space IDs
    this.storage = new Storage.Map(
      contract_id,
      user_map_space_id,
      common.uint32.decode,
      common.uint32.encode,
      () => new common.uint32()
    );
  }

  get_space_id(user: Uint8Array): u32 {
    const user_space = this.storage.get(user);

    if (user_space && user_space.value && user_space.value > 0) {
      return user_space.value;
    }

    let counterValue = this.counter.get()!.value;
    if (counterValue == 0) {
      counterValue = this.user_space_id_start;
    }

    counterValue++;

    this.counter.put(new common.uint32(counterValue));
    this.storage.put(user, new common.uint32(counterValue));

    return counterValue;
  }
}