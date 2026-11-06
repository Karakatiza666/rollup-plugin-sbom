import { createRecordCache } from "host";

const cache = createRecordCache(2);
cache.store("answer", { value: 42 });
alert(JSON.stringify(cache.load("answer")));
