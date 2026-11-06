# Units & structures reference

_Generated from `src/game/data` by `node scripts/gen-docs.ts` - do not edit by hand._

Costs are minerals / gas; times are in game seconds; ranges and speeds in tiles.

## Ironpaw

Hard-working brown bears of the timber country. Hardhats build and repair; rugged infantry, steam-plated war bears and armored airships.

### Units

| Unit | Cost | Supply | Time | HP | Armor | Speed | Weapons | Produced at | Requires |
|---|---|---|---|---|---|---|---|---|---|
| **Hardhat** _(worker, radius 7)_ | 50 | 1 | 12 | 45 | 0 | 3.94 | Blowtorch: 5, range melee, 1.07s, ground | Grand Lodge | - |
| **Ranger** _(radius 8)_ | 50 | 1 | 18 | 45 | 0 | 3.15 | Bramble Rifle: 6, range 5, 0.61s, both | Bunkhouse | - |
| **Grizzly** _(radius 12)_ | 100 / 25 | 2 | 21 | 125 | 1 | 3.15 | Sap Launcher: 10 (+10 armored), range 6, 1.07s, ground | Bunkhouse | Academy |
| **Honey Medic** _(radius 8)_ | 50 / 25 | 1 | 21 | 60 | 1 | 3.15 | - | Bunkhouse | Academy |
| **Blaze Rider** _(radius 11)_ | 100 | 2 | 21 | 90 | 0 | 5.95 | Steam Flamer: 8 (+6 light), range 5, 1.79s, ground, splash | Steamworks | - |
| **Blaze Brute** _(radius 11)_ | 100 | 2 | 21 | 135 | 0 | 3.15 | Inferno Paws: 18 (+12 light), range 2, 1.43s, ground, splash | mode of Blaze Rider | - |
| **Sapper** _(radius 7)_ | 75 / 25 | 2 | 21 | 90 | 0 | 3.94 | - | Steamworks | - |
| **Sapper (Dug In)** _(hidden, radius 7)_ | 75 / 25 | 2 | 21 | 90 | 0 | 0 | Powder Keg: 125, range 5, 20s, both, splash | mode of Sapper | - |
| **Kodiak** _(radius 18)_ | 150 / 125 | 3 | 32 | 175 | 1 | 3.15 | Back Cannons: 15 (+10 armored), range 7, 1.04s, ground | Steamworks | - |
| **Kodiak (Braced)** _(radius 18)_ | 150 / 125 | 3 | 32 | 175 | 1 | 0 | Boulder Shells: 40 (+30 armored), range 13, 2.14s, ground, splash | mode of Kodiak | - |
| **Tracker** _(radius 13)_ | 150 / 100 | 3 | 32 | 160 | 1 | 4.13 | Paw Cannon: 14, range 5, 0.8s, both | Steamworks | - |
| **Ironhide** _(radius 16)_ | 125 / 50 | 2 | 30 | 150 | 1 | 3.15 | Steam Autocannons: 12, range 6, 1s, ground<br>Skyhook Missiles: 10×2 (+4 armored), range 9, 1.6s, air | Steamworks | Armory |
| **Barnstormer** _(air, radius 13)_ | 150 / 75 | 2 | 30 | 135 | 0 | 3.85 | Prop Rockets: 10×2 (+4 armored), range 9, 2s, air<br>Strafing Guns: 12, range 5, 1.4s, ground | Airfield | - |
| **Hoverbear** _(air, radius 14)_ | 150 / 125 | 3 | 43 | 180 | 0 | 4.72 | Flak Pods: 5×2, range 5, 1.29s, air, splash | Airfield | - |
| **Hoverbear (Anchored)** _(air, radius 14)_ | 150 / 125 | 3 | 43 | 180 | 0 | 0 | Anchor Cannon: 75, range 10, 1.14s, ground | mode of Hoverbear | - |
| **Bearloon** _(air, radius 18)_ | 100 / 100 | 2 | 36 | 150 | 1 | 3.5 | - | Airfield | - |
| **Lookout** _(air, detector, radius 15)_ | 100 / 150 | 2 | 36 | 140 | 1 | 3.85 | - | Airfield | Science Lab |
| **Iron Mama** _(air, radius 36)_ | 400 / 300 | 6 | 64 | 550 | 3 | 2.62 | Broadside Batteries: 8, range 6, 0.16s, both | Airfield | Science Lab |

- **Hardhat** - Worker. A young brown bear in a hard hat: gathers resources, constructs buildings and repairs machines.
- **Ranger** - Black bear rifleman. Hits ground and air. Can use Honey Rush once researched. Abilities: *Honey Rush* (Costs health. +50% attack speed and movement speed for 11 seconds.)
- **Grizzly** - Armored grizzly. Sticky sap shells slow their targets; strong against armored ground. Abilities: *Honey Rush* (Costs health. +50% attack speed and movement speed for 11 seconds.)
- **Honey Medic** - Sun bear field medic. Patches up nearby biological units with honey bandages, using energy. Abilities: *Honey Bandage* (Automatically heals nearby biological units (costs energy).)
- **Blaze Rider** - Sloth bear on a steam bike. Its flamer scorches every enemy in a short line, deadly to light units. Can hop off to fight as a Blaze Brute. Abilities: *Hop Off* (Park the bike and fight on foot as a Blaze Brute.)
- **Blaze Brute** - The Blaze Rider on foot in steam armor. Short-range flame paws roast clumps of light units; Honey Medics can heal it. Abilities: *Hop On* (Climb back on the bike.)
- **Sapper** - Sun bear with a powder keg. Digs in to hide, then lobs the keg at the first enemy unit that comes close. Abilities: *Dig In* (Dig in and hide. Dug-in Sappers lob their keg at enemy units that come close.)
- **Sapper (Dug In)** - Hidden under the dirt until detected. Its keg hits the target for 125 and splashes everything around it, friends included. Reloads in 20 seconds. Abilities: *Dig Out* (Climb out of the hole.)
- **Kodiak** - A huge steam-plated Kodiak with a cannon on its back. Braces for devastating long-range splash artillery. Abilities: *Brace* (Lie down and brace for long-range artillery.)
- **Kodiak (Braced)** - Dug in and braced. Long range splash artillery that also hurts friendly units. Cannot move. Abilities: *Get Up* (Get back on four paws and move again.)
- **Tracker** - Brown bear in a steam buggy. Locks onto a target and keeps pounding it while kiting at speed. Abilities: *Lock On* (Locks onto an enemy unit: 300 damage over 12 seconds while it stays within 14 range. The Tracker can keep moving.)
- **Ironhide** - Spectacled bear in a steam battle suit. Autocannons for ground targets and long-range missiles against air.
- **Barnstormer** - Bear ace in a biplane. Long-range rockets against air; strafes ground targets.
- **Hoverbear** - Twin-rotor gunship. Flak pods shred groups of flyers; anchors over a zone to pound any ground unit inside it. Abilities: *Anchor Down* (Anchor over a spot. Ground units inside the 5-wide circle below get pounded.)
- **Hoverbear (Anchored)** - Anchored over a zone. Its cannon hits any ground unit inside the circle hard. Cannot move or attack air. Abilities: *Lift Anchor* (Haul up the anchor and fly again.)
- **Bearloon** - Bear-shaped hot-air balloon with a roomy basket. Carries 8 slots: infantry take 1, riders and battle suits 2, Kodiaks 4.
- **Lookout** - Gyrocopter with a spyglass. Detects hidden units, wraps allies in a Shield Bubble and drains shields and energy with Static Burst. Abilities: *Shield Bubble* (Wraps a friendly unit in a bubble that absorbs 100 damage for 11 seconds.); *Static Burst* (Removes 100 shields and 100 energy from all units in the area.)
- **Iron Mama** - Armored flagship with a mama bear figurehead. Broadside batteries hit ground and air; the Grand Cannon obliterates a single target. Abilities: *Grand Cannon* (After a brief charge, deals 240 damage to the target.)

### Structures

| Structure | Cost | Time | HP | Size | Provides | Requires | Notes |
|---|---|---|---|---|---|---|---|
| **Grand Lodge** | 400 | 71 | 1500 | 5×5 | 15 supply | - | trains Hardhat |
| **Larder** | 100 | 21 | 400 | 2×2 | 8 supply | - | - |
| **Refinery** | 75 | 21 | 500 | 3×3 | - | - | - |
| **Bunkhouse** | 150 | 46 | 1000 | 3×3 | - | Larder | trains Ranger, Grizzly, Honey Medic |
| **Workshop** | 125 | 25 | 850 | 3×3 | - | Grand Lodge | researches Infantry Weapons, Infantry Armor |
| **Gun Tower** | 125 | 25 | 350 | 2×2 | - | Bunkhouse | Heavy Autogun: 12, range 7, 0.9s, ground |
| **Bunker** | 100 | 21 | 400 | 3×2 | - | Bunkhouse | - |
| **Flak Turret** | 100 | 18 | 250 | 2×2 | - | Workshop | Flak Rockets: 12×2, range 7, 0.86s, air; detector |
| **Academy** | 150 | 25 | 600 | 3×3 | - | Bunkhouse | researches Honey Rush, Thick Fur |
| **Steamworks** | 150 / 100 | 43 | 1250 | 3×3 | - | Bunkhouse | trains Blaze Rider, Sapper, Tracker, Kodiak, Ironhide |
| **Armory** | 150 / 50 | 46 | 750 | 3×3 | - | Steamworks | researches Vehicle Weapons, Steam Plating, Aircraft Weapons |
| **Airfield** | 150 / 100 | 36 | 1300 | 3×3 | - | Steamworks | trains Barnstormer, Hoverbear, Bearloon, Lookout, Iron Mama |
| **Science Lab** | 150 / 150 | 46 | 750 | 3×3 | - | Airfield | researches Static Burst, Grand Cannon |

### Research

| Research | Levels | Cost (per level) | Time | At |
|---|---|---|---|---|
| **Infantry Weapons** - Increases the damage of infantry weapons. | 3 | 100 / 100, 175 / 175, 250 / 250 | 90, 110, 130 | Workshop |
| **Infantry Armor** - Increases the armor of infantry. | 3 | 100 / 100, 175 / 175, 250 / 250 | 90, 110, 130 | Workshop |
| **Vehicle Weapons** - Increases the damage of steam vehicles and war bears. | 3 | 100 / 100, 175 / 175, 250 / 250 | 90, 110, 130 | Armory |
| **Steam Plating** - Increases the armor of steam vehicles, war bears and aircraft. | 3 | 100 / 100, 175 / 175, 250 / 250 | 90, 110, 130 | Armory |
| **Aircraft Weapons** - Increases the damage of aircraft weapons. | 3 | 100 / 100, 175 / 175, 250 / 250 | 90, 110, 130 | Armory |
| **Honey Rush** - Rangers and Grizzlies can trade health for +50% attack and movement speed. | 1 | 100 / 100 | 70 | Academy |
| **Thick Fur** - Rangers gain +10 maximum health. | 1 | 100 / 100 | 57 | Academy |
| **Static Burst** - Lookouts can drain shields and energy in an area. | 1 | 150 / 150 | 79 | Science Lab |
| **Grand Cannon** - Iron Mamas can fire a 240-damage Grand Cannon. | 1 | 150 / 150 | 79 | Science Lab |

## Honey Horde

Feral bears living alongside giant bees. Cubs grow into any bear; dens stand on honeycomb; everyone heals over time.

### Units

| Unit | Cost | Supply | Time | HP | Armor | Speed | Weapons | Produced at | Requires |
|---|---|---|---|---|---|---|---|---|---|
| **Forager** _(worker, radius 7)_ | 50 | 1 | 12 | 40 | 0 | 3.94 | Little Claws: 5, range melee, 1.07s, ground | Great Hive | - |
| **Bumblebear** _(air, detector, radius 20)_ | 100 | 0 | 18 | 200 | 0 | 0.9 | - | Great Hive | - |
| **Scrapper** _(radius 5)_ | 50 | 1 (×2) | 17 | 35 | 0 | 4.13 | Tiny Claws: 5, range melee, 0.5s, ground | Great Hive | Cub Den |
| **Buzzbomb** _(radius 7)_ | 25 / 25 | 0.5 | 14 | 30 | 0 | 3.5 | Hive Smash: 16 (+19 light, +64 structure), range melee, 0.8s, ground, splash | grown from Scrapper | Apiary |
| **Stinger** _(radius 10)_ | 100 / 50 | 2 | 24 | 100 | 0 | 3.15 | Stinger Volley: 12, range 5, 0.59s, both | Great Hive | Stinger Den |
| **Bombardier** _(radius 13)_ | 25 / 75 | 3 | 9 | 120 | 1 | 3.85 | Honey Spit: 16, range 6, 1.14s, ground | grown from Stinger | Stinger Den |
| **Burrower** _(radius 14)_ | 50 / 100 | 3 | 18 | 190 | 1 | 4.13 | - | grown from Stinger | Burrow Den |
| **Burrower (Hibernating)** _(hidden, radius 14)_ | 50 / 100 | 3 | 18 | 190 | 1 | 0 | Spine Eruption: 20 (+10 armored), range 8, 1.43s, ground | mode of Burrower | - |
| **Hornet** _(air, radius 12)_ | 100 / 100 | 2 | 24 | 120 | 0 | 5.6 | Bouncing Stinger: 9, range 3, 1.52s, both, bounces | Great Hive | Hornet Nest |
| **Den Mother** _(radius 16)_ | 100 / 75 | 3 | 29 | 160 | 1 | 3.15 | - | Great Hive | Swarm Pit |
| **Wild Cub** _(radius 5)_ | 0 | 0 | 0 | 50 | 0 | 4.13 | Feral Bite: 10, range melee, 0.6s, ground | released by Den Mothers | - |
| **Longtongue** _(air, radius 14)_ | 100 / 200 | 3 | 29 | 150 | 1 | 4.13 | - | Great Hive | Elder Hive |
| **Cave Titan** _(radius 34)_ | 275 / 200 | 6 | 39 | 500 | 2 | 4.13 | Titan Claws: 35, range 1, 0.61s, ground, splash | Great Hive | Titan Cavern |
| **Swarmcaller** _(radius 12)_ | 100 / 150 | 2 | 36 | 90 | 0 | 3.15 | - | Great Hive | Swarm Pit |

- **Forager** - Worker. Gathers resources and settles into Horde structures (it is used up).
- **Bumblebear** - A fuzzy striped bear buzzing along on tiny wings. Provides 8 supply and detects hidden units. With Cargo Pouch it carries 8 slots of ground units.
- **Scrapper** - Fast, cheap feral cubs. Come in pairs. Can grow into Buzzbombs.
- **Buzzbomb** - A cub hugging a stolen beehive. Rushes into enemies and smashes it: the furious swarm devastates light units and buildings. Abilities: *Smash* (Smash the hive right now.)
- **Stinger** - Shaggy bear that flings barbed stingers at ground and air. Can grow into a Bombardier or a Burrower.
- **Bombardier** - Stocky bear with bulging honey sacs. Spits honey, and lobs Scalding Honey that lands on a spot moments later. Abilities: *Scalding Honey* (Lobs boiling honey at a spot. 2.5 seconds later it deals 60 damage to every enemy there, ground or air.)
- **Burrower** - Spiny armored bear. Hibernates underground, hidden, and erupts spines through every enemy in a line. Abilities: *Hibernate* (Dig in and hide. Only hibernating Burrowers can attack.)
- **Burrower (Hibernating)** - Hidden under the comb until detected. Spines erupt in a long line, hitting every enemy ground unit and structure along it. Abilities: *Wake Up* (Climb out and move again.)
- **Hornet** - Wasp-winged bear. Its stinger bounces between up to three targets.
- **Den Mother** - Big she-bear carrying a den on her back. Releases Wild Cubs that rush the enemy and fade after 18 seconds. Abilities: *Release Cubs* (Two Wild Cubs burst out of the den and rush the target area. They fade after 18 seconds.)
- **Wild Cub** - Released by a Den Mother. Free, fierce, and gone after 18 seconds.
- **Longtongue** - Winged sun bear with an absurdly long tongue. Yanks enemies close, blinds gunners with Pollen Cloud and sets Hornet Bombs on flyers. Abilities: *Yank* (Grabs a unit with an absurdly long tongue and pulls it right next to the Longtongue.); *Pollen Cloud* (Ground units inside sneeze uncontrollably: their ranged attacks only reach melee range.); *Hornet Bomb* (Sets a hornet swarm on an enemy flyer: 120 damage over 7 seconds to every enemy flyer near it.)
- **Cave Titan** - Colossal prehistoric cave bear in honeycomb armor. Its claws cleave through groups of ground units.
- **Swarmcaller** - Bear shaman wreathed in bees. Bee Cloud shields ground units from ranged attacks; Sting Swarm wears down everything in an area. Abilities: *Bee Cloud* (A buzzing bee cloud that blocks all ranged attacks against ground units inside it.); *Sting Swarm* (Deals 120 damage over 8 seconds to all enemy units and structures in the area. Cannot kill.)

### Structures

| Structure | Cost | Time | HP | Size | Provides | Requires | Notes |
|---|---|---|---|---|---|---|---|
| **Great Hive** | 300 | 71 | 1500 | 5×5 | 6 supply | - | cubs grow into Forager, Bumblebear, Scrapper, Stinger, Hornet, Den Mother, Longtongue, Cave Titan, Swarmcaller |
| **Nectar Tap** | 25 | 21 | 500 | 3×3 | - | - | - |
| **Cub Den** | 200 | 46 | 1000 | 3×3 | - | Great Hive | researches Zoomies |
| **Honey Cellar** | 75 | 25 | 750 | 3×3 | - | Great Hive | researches Sharper Claws, Barbed Stings, Thick Hide, Bigger Wings, Cargo Pouch |
| **Thorn Stump** | 100 | 36 | 300 | 2×2 | - | Cub Den | Thorn Spike: 25 (+5 armored), range 7, 1.85s, ground |
| **Sting Tower** | 75 | 21 | 400 | 2×2 | - | Cub Den | Sting Burst: 15 (+15 bio), range 7, 0.61s, air; detector |
| **Apiary** | 100 / 50 | 43 | 850 | 3×3 | - | Cub Den | researches Busy Bees |
| **Stinger Den** | 100 / 100 | 29 | 850 | 3×3 | - | Royal Hive | researches Long Stingers, Bounding Gait |
| **Burrow Den** | 100 / 150 | 57 | 850 | 3×3 | - | Royal Hive, Stinger Den | - |
| **Hornet Nest** | 200 / 200 | 71 | 850 | 3×3 | - | Royal Hive | researches Flyer Stings, Flyer Hide |
| **Swarm Pit** | 100 / 100 | 36 | 850 | 3×3 | - | Royal Hive | researches Sting Swarm |
| **Titan Cavern** | 150 / 200 | 46 | 850 | 3×3 | - | Elder Hive | researches Honeycomb Armor |
| **Royal Hive** | 150 / 100 | 57 | 2000 | 5×5 | 6 supply | Cub Den | cubs grow into Forager, Bumblebear, Scrapper, Stinger, Hornet, Den Mother, Longtongue, Cave Titan, Swarmcaller; evolved from Great Hive |
| **Elder Hive** | 200 / 150 | 71 | 2500 | 5×5 | 6 supply | Swarm Pit | cubs grow into Forager, Bumblebear, Scrapper, Stinger, Hornet, Den Mother, Longtongue, Cave Titan, Swarmcaller; evolved from Royal Hive |

### Research

| Research | Levels | Cost (per level) | Time | At |
|---|---|---|---|---|
| **Sharper Claws** - Increases the damage of Horde melee attacks. | 3 | 100 / 100, 150 / 150, 200 / 200 | 90, 110, 130 | Honey Cellar |
| **Barbed Stings** - Increases the damage of Horde ranged attacks. | 3 | 100 / 100, 150 / 150, 200 / 200 | 90, 110, 130 | Honey Cellar |
| **Thick Hide** - Increases the armor of Horde ground units. | 3 | 150 / 150, 225 / 225, 300 / 300 | 90, 110, 130 | Honey Cellar |
| **Flyer Stings** - Increases the damage of Horde flyers. | 3 | 100 / 100, 175 / 175, 250 / 250 | 90, 110, 130 | Hornet Nest |
| **Flyer Hide** - Increases the armor of Horde flyers. | 3 | 150 / 150, 225 / 225, 300 / 300 | 90, 110, 130 | Hornet Nest |
| **Zoomies** - Scrappers move 60% faster. | 1 | 100 / 100 | 79 | Cub Den |
| **Bigger Wings** - Bumblebears fly almost three times faster. | 1 | 100 / 100 | 43 | Honey Cellar |
| **Cargo Pouch** - Bumblebears can carry ground units (8 slots). | 1 | 200 / 200 | 79 | Honey Cellar |
| **Busy Bees** - Buzzbombs move faster. | 1 | 100 / 100 | 79 | Apiary |
| **Long Stingers** - Stingers gain +1 attack range. | 1 | 100 / 100 | 71 | Stinger Den |
| **Bounding Gait** - Stingers move 25% faster. | 1 | 100 / 100 | 71 | Stinger Den |
| **Honeycomb Armor** - Cave Titans gain +2 armor. | 1 | 150 / 150 | 79 | Titan Cavern |
| **Sting Swarm** - Swarmcallers can cast Sting Swarm. | 1 | 150 / 150 | 79 | Swarm Pit |

## Starborn

Panda Sage polar, spirit and moon bears. Structures are called down by starlight and need a Star Totem; every bear wears an aurora shield.

### Units

| Unit | Cost | Supply | Time | HP | Armor | Speed | Weapons | Produced at | Requires |
|---|---|---|---|---|---|---|---|---|---|
| **Snowcub** _(worker, radius 7)_ | 50 | 1 | 12 | 20 + 20 shields | 0 | 3.94 | Star Spark: 5, range melee, 1.07s, ground | Star Temple | - |
| **Spirit Bear** _(radius 11)_ | 100 | 2 | 27 | 100 + 50 shields | 1 | 3.15 | Aurora Claws: 8×2, range melee, 0.86s, ground | Moon Gate | - |
| **Moon Bear** _(radius 14)_ | 125 / 50 | 2 | 30 | 90 + 80 shields | 1 | 4.13 | Moon Orbs: 14 (+5 armored), range 6, 1.34s, both | Moon Gate | Spirit Lodge |
| **Glacier Bear** _(radius 10)_ | 100 / 25 | 2 | 30 | 70 + 70 shields | 1 | 3.5 | Frost Glaive: 10 (+12 light), range 4, 1.61s, ground | Moon Gate | Spirit Lodge |
| **Panda Sage** _(radius 10)_ | 50 / 150 | 2 | 39 | 40 + 40 shields | 0 | 2.62 | - | Moon Gate | Sage Library |
| **Shadowpaw** _(hidden, radius 10)_ | 125 / 125 | 2 | 39 | 40 + 80 shields | 1 | 3.94 | Shadow Scythe: 45, range melee, 1.21s, ground | Moon Gate | Sage Library |
| **Little Dipper** _(air, detector, hidden, radius 8)_ | 25 / 75 | 1 | 21 | 40 + 20 shields | 0 | 2.63 | - | Frost Works | - |
| **Floe Bear** _(air, radius 17)_ | 200 | 2 | 36 | 80 + 60 shields | 1 | 3.5 | - | Frost Works | - |
| **Snowballer** _(radius 14)_ | 150 / 150 | 3 | 36 | 100 + 100 shields | 1 | 3.15 | - | Frost Works | Sage Library |
| **Polar Colossus** _(radius 30)_ | 300 / 200 | 6 | 54 | 200 + 150 shields | 1 | 3.15 | Eye Beams: 12×2 (+5 light), range 7, 1.07s, ground, splash | Frost Works | - |
| **Starwing** _(air, radius 12)_ | 150 / 100 | 2 | 25 | 120 + 60 shields | 0 | 5.95 | Prism Lances: 5×2 (+5 light), range 5, 0.79s, air | Sky Altar | - |
| **Seer** _(air, radius 12)_ | 150 / 150 | 3 | 37 | 100 + 60 shields | 0 | 5.6 | - | Sky Altar | - |
| **Seer (Sunlance)** _(air, radius 12)_ | 150 / 150 | 3 | 37 | 100 + 60 shields | 0 | 5.6 | Sunlance: 15 (+7 light), range 4, 0.61s, ground | mode of Seer | - |
| **Great Bear** _(air, radius 38)_ | 350 / 250 | 6 | 64 | 300 + 150 shields | 2 | 2.62 | Comet Lance: 30 (+22 massive), range 14, 2.6s, air<br>Star Bolt: 30 (+15 massive), range 10, 1.9s, ground | Sky Altar | Great Beacon |

- **Snowcub** - Worker. A little polar cub with a star on its brow: gathers resources and calls structures down from the sky, then is free to go.
- **Spirit Bear** - White spirit bear with blazing aurora claws. Learns to Pounce once researched. Abilities: *Pounce* (Spirit Bears move faster and pounce onto nearby targets.)
- **Moon Bear** - Agile bear with a glowing crescent that fires moon orbs at ground and air. Can Moonstep short distances. Abilities: *Moonstep* (Instantly teleports a short distance.)
- **Glacier Bear** - Blue-grey raider whose ice glaives shred light units. Its spirit runs ahead, and the bear follows in a flash. Abilities: *Spirit Walk* (The bear's spirit runs to a spot. 7 seconds later the bear appears wherever its spirit is.)
- **Panda Sage** - Floating panda mystic. Starfall tears apart everything caught beneath it, friend or foe. Abilities: *Starfall* (Deals 80 damage over 3 seconds to ALL units in the area, including your own.)
- **Shadowpaw** - Assassin wrapped in shadow. Always hidden unless detected.
- **Little Dipper** - A tiny bear of stars, nearly invisible. Scouts and detects hidden units.
- **Floe Bear** - Polar bear steering a flying ice floe. Carries 8 slots: Snowcubs take 1, warriors 2, Polar Colossi 4.
- **Snowballer** - Polar bear with a crackling star-snowball. Rolls it into the enemy, where it bursts and hurts every ground unit nearby, friend or foe. Abilities: *Star Snowball* (Rolls a crackling snowball toward a spot. It bursts after 2 seconds: 145 damage (+55 to shields) to ALL ground units nearby, including your own.)
- **Polar Colossus** - Towering polar bear in starmetal armor. Its eye beams scorch groups of ground units.
- **Starwing** - Spirit bear on wings of light. Fast air superiority; attacks air units only.
- **Seer** - Spectacled bear on a floating star disc. Fast raider: lights its Sunlance to burn light ground units, and casts Revelation to expose an area. Abilities: *Light Sunlance* (Light a searing beam that hits ground targets. Burns 2 energy per second.); *Revelation* (Reveals and detects an area for 12 seconds.)
- **Seer (Sunlance)** - Sunlance lit: a searing beam against ground targets that burns energy every second. Abilities: *Douse Sunlance* (Put the beam out to save energy.); *Revelation* (Reveals and detects an area for 12 seconds.)
- **Great Bear** - The Great Bear constellation come down to fight. Star bolts at long range against ground; comet lances outrange every flyer.

### Structures

| Structure | Cost | Time | HP | Size | Provides | Requires | Notes |
|---|---|---|---|---|---|---|---|
| **Star Temple** | 400 | 71 | 1000 + 1000 | 5×5 | 15 supply | - | trains Snowcub |
| **Star Totem** | 100 | 18 | 200 + 200 | 2×2 | 8 supply | - | - |
| **Dew Shrine** | 75 | 21 | 450 + 450 | 3×3 | - | - | - |
| **Moon Gate** | 150 | 46 | 500 + 500 | 3×3 | - | Star Temple | trains Spirit Bear, Moon Bear, Glacier Bear, Panda Sage, Shadowpaw |
| **Star Forge** | 150 | 32 | 400 + 400 | 3×3 | - | Star Temple | researches Ground Weapons, Ground Armor, Aurora Shields |
| **Star Lantern** | 150 | 29 | 150 + 150 | 2×2 | - | Star Forge | Lantern Bolt: 20, range 7, 0.89s, both; detector |
| **Spirit Lodge** | 150 | 36 | 550 + 550 | 3×3 | - | Moon Gate | researches Air Weapons, Air Armor |
| **Sky Altar** | 150 / 150 | 43 | 600 + 600 | 3×3 | - | Spirit Lodge | trains Starwing, Seer, Great Bear |
| **Frost Works** | 150 / 100 | 46 | 450 + 450 | 3×3 | - | Spirit Lodge | trains Little Dipper, Floe Bear, Snowballer, Polar Colossus; researches Long Gaze |
| **Sage Library** | 150 / 150 | 36 | 500 + 500 | 3×3 | - | Spirit Lodge | researches Pounce, Moonstep, Starfall |
| **Great Beacon** | 300 / 200 | 43 | 500 + 500 | 3×3 | - | Sky Altar | - |

### Research

| Research | Levels | Cost (per level) | Time | At |
|---|---|---|---|---|
| **Ground Weapons** - Increases the damage of ground units. | 3 | 100 / 100, 150 / 150, 200 / 200 | 90, 110, 130 | Star Forge |
| **Ground Armor** - Increases the armor of ground units. | 3 | 100 / 100, 150 / 150, 200 / 200 | 90, 110, 130 | Star Forge |
| **Aurora Shields** - Increases the shield armor of all units and structures. | 3 | 150 / 150, 225 / 225, 300 / 300 | 90, 110, 130 | Star Forge |
| **Air Weapons** - Increases the damage of flyers. | 3 | 100 / 100, 175 / 175, 250 / 250 | 90, 110, 130 | Spirit Lodge |
| **Air Armor** - Increases the armor of flyers. | 3 | 150 / 150, 225 / 225, 300 / 300 | 90, 110, 130 | Spirit Lodge |
| **Pounce** - Spirit Bears move faster and pounce onto targets. | 1 | 100 / 100 | 100 | Sage Library |
| **Moonstep** - Moon Bears can teleport a short distance. | 1 | 150 / 150 | 90 | Sage Library |
| **Starfall** - Panda Sages can cast Starfall. | 1 | 200 / 200 | 79 | Sage Library |
| **Long Gaze** - Polar Colossi gain +2 attack range. | 1 | 150 / 150 | 71 | Frost Works |

