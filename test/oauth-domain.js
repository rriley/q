// Replicates the exact guard expressions from routes/login.js get_callback.
function decide(profile, allowed_domain, owner_email) {
    if (!profile.email || !profile.verified_email) return "reject: unverified";
    if (allowed_domain && profile.hd !== allowed_domain && profile.email !== owner_email) {
        return "reject: wrong domain";
    }
    return "ALLOW";
}
const OWNER = "boss@gmail.com";
const D = "andrew.cmu.edu";
const cases = [
  [{email:"stu@andrew.cmu.edu", hd:"andrew.cmu.edu", verified_email:true}, D, "ALLOW",              "real Andrew account"],
  [{email:"stu@gmail.com",      hd:undefined,        verified_email:true}, D, "reject: wrong domain","gmail impersonating an Andrew ID"],
  [{email:"stu@gmail.com",      hd:"evil.com",       verified_email:true}, D, "reject: wrong domain","other workspace domain"],
  [{email:OWNER,                hd:undefined,        verified_email:true}, D, "ALLOW",              "owner on a personal account"],
  [{email:"stu@andrew.cmu.edu", hd:"andrew.cmu.edu", verified_email:false},D, "reject: unverified", "unverified address"],
  [{email:undefined,            hd:"andrew.cmu.edu", verified_email:true}, D, "reject: unverified", "no address at all"],
  [{email:"any@gmail.com",      hd:undefined,        verified_email:true}, "", "ALLOW",             "allowed_domain disabled"],
  [{email:"stu@andrew.cmu.edu.evil.com", hd:"evil.com", verified_email:true}, D, "reject: wrong domain","lookalike domain suffix"],
];
let fails = 0;
for (const [p, dom, want, label] of cases) {
    const got = decide(p, dom, OWNER);
    const ok = got === want;
    if (!ok) fails++;
    console.log(`  ${ok?"PASS":"FAIL"}  ${label.padEnd(34)} -> ${got}`);
}
console.log(fails === 0 ? "\nAll checks passed." : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
